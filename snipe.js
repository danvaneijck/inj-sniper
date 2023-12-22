const {
    ChainGrpcWasmApi,
    IndexerGrpcAccountPortfolioApi,
    PrivateKey,
    ChainGrpcBankApi,
    MsgExecuteContractCompat
} = require('@injectivelabs/sdk-ts');
const { getNetworkEndpoints, Network } = require('@injectivelabs/networks');
const { DenomClientAsync } = require('@injectivelabs/sdk-ui-ts');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const moment = require('moment');
const fs = require('fs/promises');
const TransactionManager = require("./transactions")
require('dotenv').config();

class AstroportSniper {
    constructor(config) {
        this.RPC = config.gRpc
        this.live = config.live

        console.log("Init on ", this.RPC)

        this.chainGrpcWasmApi = new ChainGrpcWasmApi(this.RPC);
        this.astroFactory = process.env.FACTORY_CONTRACT;
        this.astroRouter = process.env.ROUTER_CONTRACT;
        this.pricePair = process.env.PRICE_PAIR_CONTRACT; // INJ / USDT

        this.denomClient = new DenomClientAsync(Network.Mainnet, {
            endpoints: {
                grpc: this.RPC,
                indexer: "https://sentry.exchange.grpc-web.injective.network",
                rest: "https://sentry.lcd.injective.network",
                rpc: "https://sentry.tm.injective.network"
            }
        })

        this.chainGrpcBankApi = new ChainGrpcBankApi(this.RPC)

        this.privateKey = PrivateKey.fromMnemonic(process.env.MNEMONIC)
        this.publicKey = this.privateKey.toAddress()

        this.walletAddress = this.privateKey.toAddress().toBech32()
        console.log(`Loaded wallet from private key ${this.walletAddress}`)

        this.txManager = new TransactionManager(this.privateKey)

        this.baseAssetName = "INJ"
        this.baseDenom = "inj"
        this.baseAsset = null
        this.stableAsset = null
        this.baseAssetPrice = 0;

        this.tokenTypes = ['native', 'tokenFactory'];
        this.pairType = '{"xyk":{}}';

        this.lowLiquidityThreshold = config.lowLiquidityThreshold
        this.highLiquidityThreshold = config.highLiquidityThreshold

        this.snipeAmount = config.snipeAmount
        this.profitGoalPercent = config.profitGoalPercent
        this.stopLoss = config.stopLoss
        this.maxSpread = config.maxSpread
        this.tradeTimeLimit = config.tradeTimeLimit
        this.positions = new Map()

        this.allPairs = new Map();
        this.ignoredPairs = new Set();

        this.pairPriceMonitoringIntervals = new Map();
        this.lowLiquidityPairMonitoringIntervals = new Map();
        this.sellPairPriceMonitoringIntervals = new Map();
        this.lastPrices = new Map();

        this.monitoringNewPairIntervalId = null;
        this.monitoringBasePairIntervalId = null;

        this.discordToken = process.env.DISCORD_TOKEN;
        this.discordChannelId = process.env.DISCORD_CHANNEL;

        this.discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
        this.discordClient.login(this.discordToken);

        this.discordClient.on('ready', () => {
            console.log(`Logged in as ${this.discordClient.user.tag}!`);
            this.discordClient.guilds.cache.forEach(guild => {
                guild.commands.create(new SlashCommandBuilder()
                    .setName('get_positions')
                    .setDescription('Get portfolio positions for a wallet address')
                );
                guild.commands.create(new SlashCommandBuilder()
                    .setName('buy_token')
                    .addStringOption(option => option.setName('pair').setDescription('The pair to buy').setRequired(true))
                    .addNumberOption(option => option.setName('amount').setDescription('The amount to buy').setRequired(true))
                    .setDescription('Buy a token using the pair address')
                );
                guild.commands.create(new SlashCommandBuilder()
                    .setName('sell_token')
                    .addStringOption(option => option.setName('pair').setDescription('The pair to sell').setRequired(true))
                    .setDescription('Sell a token using the pair address')
                );
            });
            console.log("set up discord slash commands")
        });

        this.allPairsQuery = {
            pairs: {
                start_after: [],
                limit: 50,
            },
        };
    }

    async initialize(pairType, tokenTypes, backfill = false) {
        this.pairType = pairType
        this.tokenTypes = tokenTypes
        this.setupDiscordCommands()
        if (backfill) {
            this.live = false
        }
        try {
            await this.loadFromFile('data.json');
            await this.updateBaseAssetPrice()
            await this.getPairs(pairType, tokenTypes, backfill);
        } catch (error) {
            console.error('Error during initialization:', error);
        }
    }

    async getBalanceOfToken(denom) {
        return await this.chainGrpcBankApi.fetchBalance({
            accountAddress: this.walletAddress,
            denom,
        })
    }

    setupDiscordCommands() {
        this.discordClient.on('interactionCreate', async interaction => {
            if (!interaction.isCommand()) return;
            const { commandName } = interaction;
            if (commandName === 'get_positions') {
                await interaction.reply("Fetching wallet holdings...");
                await this.executeGetPositionsCommand();
            }
            if (commandName === 'buy_token') {
                await interaction.reply("Buying token");
                const pairContract = interaction.options.getString('pair');
                const amount = interaction.options.getNumber('amount');
                await this.executeBuyCommand(pairContract, amount);
            }
            if (commandName === 'sell_token') {
                await interaction.reply("Selling token");
                const pairContract = interaction.options.getString('pair');
                await this.executeSellCommand(pairContract);
            }
        });
    }

    async executeGetPositionsCommand() {
        try {
            const walletAddress = this.walletAddress;
            const portfolio = await this.getPortfolio(walletAddress);
            const message = `**Current holdings for ${walletAddress}**\n${await this.formatPortfolioMessage(portfolio)}`;
            await this.sendMessageToDiscord(message)
        } catch (error) {
            console.error('Error executing /get_positions command:', error);
            await this.sendMessageToDiscord('Error executing /get_positions command')
        }
    }

    async executeBuyCommand(pairContract, amount) {
        try {
            let pair = await this.getPairInfo(pairContract)
            if (!pair) {
                this.sendMessageToDiscord(`Could not get pair`)
                return
            }
            await this.calculateLiquidity(pair)
            if (pair.liquidity < this.lowLiquidityThreshold) {
                this.monitorLowLiquidityPair(pair, 5, this.lowLiquidityThreshold)
                await this.sendMessageToDiscord(`:eyes: Monitoring token for liquidity change`)
                return
            }
            let result = await this.buyMemeToken(pair, amount)
            if (result && !this.allPairs.has(pairContract)) {
                this.allPairs.set(pairContract, pair);
                this.ignoredPairs.delete(pairContract);
            }
        } catch (error) {
            console.error('Error executing /buy_token command:', error);
            await this.sendMessageToDiscord('Error executing /buy_token command')
        }
    }

    async executeSellCommand(pairContract) {
        try {
            let pair = await this.getPairInfo(pairContract)
            let result = await this.sellMemeToken(pair)
            if (result && !this.allPairs.has(pairContract)) {
                this.allPairs.set(pairContract, pair);
                this.ignoredPairs.delete(pairContract);
            }
        } catch (error) {
            console.error('Error executing /sell_token command:', error);
            await this.sendMessageToDiscord('Error executing /sell_token command')
        }
    }

    async loadFromFile(filename) {
        try {
            const data = await fs.readFile(filename, 'utf-8');
            const jsonData = JSON.parse(data);
            if (jsonData.allPairs) {
                this.allPairs = new Map(jsonData.allPairs.map(pair => [pair.contract_addr, pair]));
                console.log('Loaded allPairs from file');
            }
            if (jsonData.positions) {
                this.positions = new Map(jsonData.positions.map(position => [position.pair_contract, position]));
                console.log('Loaded positions from file');
            }
            if (jsonData.ignoredPairs) {
                this.ignoredPairs = new Set(jsonData.ignoredPairs);
                console.log('Loaded ignoredPairs from file');
            }
        } catch (error) {
            console.error('Error loading data from file:', error);
        }
    }

    async saveToFile(filename) {
        try {
            const dataToSave = {
                allPairs: Array.from(this.allPairs.values()),
                positions: Array.from(this.positions.values()),
                ignoredPairs: Array.from(this.ignoredPairs),
            };
            await fs.writeFile(filename, JSON.stringify(dataToSave, null, 2), 'utf-8');
        } catch (error) {
            console.error('Error saving data to file:', error);
        }
    }

    async sendMessageToDiscord(message) {
        if (!this.discordClient || !this.discordChannelId) {
            console.error('Discord client or channel information not available.');
            return;
        }

        const channel = this.discordClient.channels.cache.get(this.discordChannelId);
        if (!channel) {
            console.error('Discord channel not found.');
            return;
        }

        try {
            await channel.send(message);
        } catch (error) {
            console.error('Error sending message to Discord channel:', error);
        }
    }

    async updateBaseAssetPrice() {
        let baseAssetPair = await this.getPairInfo(this.pricePair)
        this.allPairs.set(this.pricePair, baseAssetPair)
        let quote = await this.getQuote(baseAssetPair, 1)
        if (!quote) return
        this.baseAssetPrice = quote['return_amount']
        this.stableAsset = baseAssetPair.token0Meta
        this.baseAsset = baseAssetPair.token1Meta

        const currentPrice = quote['return_amount'] / Math.pow(10, this.stableAsset.decimals)
        if (this.discordClient && this.discordClient.user) {
            const activityText = `${this.baseAssetName}: $${currentPrice}`;
            this.discordClient.user.setActivity(activityText, { type: ActivityType.Watching });
        }
        await this.saveToFile('data.json')
    }

    startMonitoringBasePair(intervalInSeconds) {
        console.log('Base Asset monitoring started.');
        this.monitoringBasePairIntervalId = setInterval(async () => {
            await this.updateBaseAssetPrice();
        }, intervalInSeconds * 1000);
    }

    stopMonitoringBasePair() {
        clearInterval(this.monitoringBasePairIntervalId);
        console.log('Base Asset monitoring stopped.');
    }

    async getPairs(pairType, tokenTypes, backfill = false) {
        try {
            const startTime = new Date().getTime();
            let previousPairs = null;

            while (true) {
                const queryObject = Buffer.from(JSON.stringify(this.allPairsQuery)).toString('base64');

                const contractState = await this.chainGrpcWasmApi.fetchSmartContractState(
                    this.astroFactory,
                    queryObject
                );

                const decodedJson = JSON.parse(new TextDecoder().decode(contractState.data));

                if (previousPairs && JSON.stringify(decodedJson.pairs) === JSON.stringify(previousPairs)) {
                    console.log("Previous list matches returned list, returning", decodedJson);
                    break;
                }

                if (!decodedJson.pairs || decodedJson.pairs.length === 0) {
                    break;
                }

                for (const pair of decodedJson.pairs) {
                    const contractAddr = pair.contract_addr;
                    if (!this.allPairs.has(contractAddr) && !this.ignoredPairs.has(contractAddr)) {

                        console.log("get pair info for", contractAddr);
                        let pairInfo = await this.getPairInfo(contractAddr);

                        if (
                            pairInfo &&
                            pairInfo.token0Meta &&
                            pairInfo.token1Meta &&
                            tokenTypes.includes(pairInfo.token0Meta.tokenType) &&
                            tokenTypes.includes(pairInfo.token1Meta.tokenType) &&
                            pairType === JSON.stringify(pairInfo.pair_type) &&
                            (pairInfo.token0Meta.denom === this.baseDenom ||
                                pairInfo.token1Meta.denom === this.baseDenom)
                        ) {
                            this.allPairs.set(pair.contract_addr, { ...pair, ...pairInfo });
                            const message = `:new: New pair found: ${pairInfo.token0Meta.symbol}, ` +
                                `${pairInfo.token1Meta.symbol}: \n${pairInfo.astroportLink}\n` +
                                `${pairInfo.dexscreenerLink}\n <@352761566401265664>`;

                            console.log(message);

                            if (!backfill) {
                                this.sendMessageToDiscord(message);
                                await this.calculateLiquidity({ ...pair, ...pairInfo });
                                console.log(`${contractAddr} liquidity: ${pair.liquidity}`)

                                if (pair.liquidity > this.lowLiquidityThreshold &&
                                    pair.liquidity < this.highLiquidityThreshold) {
                                    await this.buyMemeToken(pair, this.snipeAmount);
                                } else {
                                    await this.monitorLowLiquidityPair({ ...pair, ...pairInfo }, 5, this.lowLiquidityThreshold);
                                }
                            }

                        } else {
                            console.log(`Ignored pair ${contractAddr}, ${JSON.stringify(pairInfo, null, 2)}`);
                            if (!backfill) {
                                this.sendMessageToDiscord(`Ignored new pair https://dexscreener.com/injective/${contractAddr}`);
                            }
                            this.ignoredPairs.add(contractAddr);
                        }
                    }
                }
                const lastPair = decodedJson.pairs[decodedJson.pairs.length - 1];
                this.allPairsQuery.pairs.start_after = lastPair.asset_infos;
                previousPairs = decodedJson.pairs;
            }

            const endTime = new Date().getTime(); // Record the end time
            const executionTime = endTime - startTime;
            console.log(`Finished check for new pairs in ${executionTime} milliseconds`);
            await this.saveToFile('data.json');
            return this.allPairs;
        } catch (error) {
            console.error('Error fetching all astro port pairs:', error.originalMessage ?? error);
        }
    }

    async getTokenInfo(denom) {
        try {
            const token = await this.denomClient.getDenomToken(denom)
            return token;
        } catch (error) {
            console.error('Error fetching token info:', error);
            return {}
        }
    }

    async getPairInfo(pairContract) {
        let retryCount = 0;

        while (retryCount < 1) {
            try {
                const pairQuery = Buffer.from(JSON.stringify({ pair: {} })).toString('base64');
                const pairInfo = await this.chainGrpcWasmApi.fetchSmartContractState(pairContract, pairQuery);
                const infoDecoded = JSON.parse(new TextDecoder().decode(pairInfo.data));
                const assetInfos = infoDecoded['asset_infos'];
                const tokenInfos = [];

                for (const assetInfo of assetInfos) {
                    const contract = assetInfo['native_token']
                        ? assetInfo['native_token']['denom']
                        : assetInfo['token']['contract_addr'];

                    const tokenInfo = await this.getTokenInfo(contract);
                    tokenInfos.push({
                        denom: contract,
                        name: 'n/a',
                        symbol: 'n/a',
                        decimals: 6, // guess the token decimals
                        tokenType: "tokenFactory",
                        ...tokenInfo,
                    });
                }
                const [token0Info, token1Info] = tokenInfos;

                return {
                    token0Meta: token0Info,
                    token1Meta: token1Info,
                    astroportLink: `https://app.astroport.fi/swap?from=${token0Info.denom}&to=${token1Info.denom}`,
                    coinhallLink: `https://coinhall.org/injective/${pairContract}`,
                    dexscreenerLink: `https://dexscreener.com/injective/${pairContract}?maker=${this.walletAddress}`,
                    contract_addr: pairContract,
                    pair_type: infoDecoded.pair_type,
                    asset_infos: infoDecoded.asset_infos,
                };

            } catch (error) {
                if (error.name == "GrpcUnaryRequestException") {
                    console.error(`Error fetching pair ${pairContract} info. Retrying... (Retry count: ${retryCount + 1})`);
                    retryCount++;
                } else {
                    console.error(`Error fetching pair ${pairContract} info:`, error);
                    break;
                }
            }
        }
        console.error(`Max retry count reached. Unable to fetch pair ${pairContract} info.`);
        return null;
    }

    async getQuote(pair, amount) {
        if (!pair) return
        const offerAmount = amount * Math.pow(10, this.baseAsset ? this.baseAsset.decimals : 18);
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
        const simulationQuery = {
            simulation: {
                offer_asset: {
                    info: {
                        native_token: {
                            denom: 'inj'
                        }
                    },
                    amount: offerAmount.toString()
                }
            }
        };
        try {
            const query = Buffer.from(JSON.stringify(simulationQuery)).toString('base64');
            const sim = await this.chainGrpcWasmApi.fetchSmartContractState(pair.contract_addr, query);

            const decodedData = JSON.parse(new TextDecoder().decode(sim.data));
            return decodedData;
        } catch (error) {
            console.error(`Error getting quote for ${pairName}: ${error}`);
        }
    }

    async getQuoteFromRouter(pair, amount) {
        if (!pair || !pair.asset_infos || !Array.isArray(pair.asset_infos)) {
            console.error(`Invalid pair or asset_infos for getQuoteFromRouter:`, pair);
            return;
        }

        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
        const askAssetIndex = pair.asset_infos.findIndex(assetInfo => assetInfo.native_token.denom !== this.baseDenom);
        if (askAssetIndex === -1) {
            console.error(`Error finding ask asset for ${pairName}`);
            return;
        }

        const askAssetInfo = pair.asset_infos[askAssetIndex];
        const offerAmount = amount * Math.pow(10, this.baseAsset.decimals);

        const simulationQuery = {
            simulate_swap_operations: {
                offer_amount: offerAmount.toString(),
                operations: [
                    {
                        astro_swap: {
                            offer_asset_info: {
                                native_token: {
                                    denom: this.baseDenom
                                }
                            },
                            ask_asset_info: askAssetInfo
                        }
                    }
                ]
            }
        };

        try {
            const query = Buffer.from(JSON.stringify(simulationQuery)).toString('base64');
            const sim = await this.chainGrpcWasmApi.fetchSmartContractState(this.astroRouter, query);

            const decodedData = JSON.parse(new TextDecoder().decode(sim.data));
            return decodedData;
        } catch (error) {
            console.error(`Error getting quote for ${pairName}: ${error}`);
        }
    }

    async getSellQuoteFromRouter(pair, amount) {
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;

        try {
            if (!pair || !pair.asset_infos || !Array.isArray(pair.asset_infos)) {
                throw new Error(`Invalid pair or asset_infos for getSellQuoteFromRouter: ${pair}`);
            }

            const assetToSell = pair.asset_infos.findIndex(assetInfo => {
                const isNativeToken = assetInfo.native_token && assetInfo.native_token.denom !== this.baseDenom;
                const isCW20Token = assetInfo.token && assetInfo.token.contract_addr !== this.baseTokenContractAddr;
                return isNativeToken || isCW20Token;
            });

            if (assetToSell === -1) {
                throw new Error(`Error finding ask asset for ${pairName}`);
            }
            const assetInfo = pair.asset_infos[assetToSell];
            console.log(assetInfo)

            const simulationQuery = {
                simulate_swap_operations: {
                    offer_amount: amount.toString(),
                    operations: [
                        {
                            astro_swap: {
                                offer_asset_info: assetInfo,
                                ask_asset_info: {
                                    native_token: {
                                        denom: this.baseDenom
                                    }
                                }
                            }
                        }
                    ]
                }
            };

            const query = Buffer.from(JSON.stringify(simulationQuery)).toString('base64');
            const sim = await this.chainGrpcWasmApi.fetchSmartContractState(this.astroRouter, query);
            const decodedData = JSON.parse(new TextDecoder().decode(sim.data));
            return decodedData;
        } catch (error) {
            console.error(`Error getting sell quote for ${pairName}: ${error}`);
            return null;
        }
    }

    async getQuotes(pairs) {
        pairs.forEach(async (pair) => {
            let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`
            let decodedData = await this.getQuote(pair, 1)
            if (decodedData) {
                console.log(`quote for ${pairName}: ${this.baseAssetPrice / decodedData['return_amount']}`)
            }
        })
    }

    startMonitoringNewPairs(intervalInSeconds) {
        if (!this.monitoringNewPairIntervalId) {
            this.sendMessageToDiscord(`Monitoring for new pairs started. Checking every ${intervalInSeconds} seconds.`);

            this.monitoringNewPairIntervalId = setInterval(async () => {
                this.allPairsQuery.pairs.start_after = []
                await this.getPairs(this.pairType, this.tokenTypes);
            }, intervalInSeconds * 1000);
        } else {
            console.log('Monitoring is already in progress.');
        }
    }

    stopMonitoringNewPairs() {
        if (this.monitoringNewPairIntervalId) {
            console.log('Monitoring stopped.');
            clearInterval(this.monitoringNewPairIntervalId);
            this.monitoringNewPairIntervalId = null;
        } else {
            console.log('No active monitoring to stop.');
        }
    }

    async calculateLiquidity(pair) {
        if (!pair) return
        try {
            const poolQuery = Buffer.from(JSON.stringify({ pool: {} })).toString('base64');
            let poolInfo = await this.chainGrpcWasmApi.fetchSmartContractState(pair.contract_addr, poolQuery)
            let poolDecoded = JSON.parse(new TextDecoder().decode(poolInfo.data))
            const baseAssetAmount = poolDecoded.assets.find(asset => {
                if (asset.info.native_token) {
                    return asset.info.native_token.denom === this.baseAsset.denom;
                } else if (asset.info.token) {
                    return asset.info.token.contract_addr === this.baseAsset.denom;
                }
                return false;
            })?.amount || 0;
            const baseAssetDecimals = this.baseAsset.decimals || 0;
            const baseAssetPrice = this.baseAssetPrice || 0;

            const numericBaseAssetAmount = Number(baseAssetAmount) / 10 ** baseAssetDecimals;
            let liquidity = numericBaseAssetAmount * baseAssetPrice;
            liquidity = (liquidity * 2) / Math.pow(10, this.stableAsset.decimals)
            pair.liquidity = liquidity
            pair.liquidityUpdate = moment()
            return liquidity;
        } catch (error) {
            console.error('Error calculating liquidity:', error.originalMessage ?? error);
            return null;
        }
    }

    async monitorPairForPriceChange(pair, intervalInSeconds, trackingDurationMinutes, priceChangeThreshold) {
        try {
            let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
            if (this.pairPriceMonitoringIntervals.has(pair.contract_addr)) {
                console.log(`Pair ${pairName} is already being monitored.`);
                return;
            }

            let lastPrices = this.lastPrices.get(pair.contract_addr) || [];

            const monitoringIntervalId = setInterval(async () => {
                const updatedPair = await this.getPairInfo(pair.contract_addr);
                if (!updatedPair) return
                this.allPairs.set(pair.contract_addr, updatedPair)

                const quote = await this.getQuoteFromRouter(updatedPair, 1);
                if (!quote) return
                const currentPrice = this.baseAssetPrice / quote['amount'];

                lastPrices.push(currentPrice);
                lastPrices = lastPrices.slice(-trackingDurationMinutes * 60 / intervalInSeconds);

                const newHighestPrice = Math.max(...lastPrices, 0);
                const newLowestPrice = Math.min(...lastPrices, Infinity);

                const priceChangeToHighest = ((currentPrice - newHighestPrice) / newHighestPrice) * 100;
                const priceChangeToLowest = ((currentPrice - newLowestPrice) / newLowestPrice) * 100;

                await this.calculateLiquidity(pair)

                if (Math.abs(priceChangeToHighest) > priceChangeThreshold) {
                    let message = `:small_red_triangle_down: ${pairName} Price is down ${parseFloat(priceChangeToHighest).toFixed(2)}% in the last ` +
                        `${trackingDurationMinutes} minutes. current: $${parseFloat(currentPrice).toFixed(10)}, ` +
                        `high: $${newHighestPrice.toFixed(10)}, liquidity: $${Math.round(pair.liquidity)}\n` +
                        `${pair.coinhallLink}\n${pair.astroportLink}`
                    this.sendMessageToDiscord(message);
                    this.lastPrices.delete(pair.contract_addr);
                    lastPrices = [];
                }

                if (priceChangeToLowest > priceChangeThreshold) {
                    let message = `:green_circle: ${pairName} price is up ${parseFloat(priceChangeToLowest).toFixed(2)}% in the last ` +
                        `${trackingDurationMinutes} minutes. current: $${parseFloat(currentPrice).toFixed(10)}, ` +
                        `low: $${newLowestPrice.toFixed(10)}, liquidity: $${Math.round(pair.liquidity)}\n` +
                        `${pair.coinhallLink}\n${pair.astroportLink}`;
                    this.sendMessageToDiscord(message);
                    this.lastPrices.delete(pair.contract_addr);
                    lastPrices = [];
                }

                console.log(`${pairName} price ${parseFloat(currentPrice).toFixed(10)}, liquidity: $${Math.round(pair.liquidity)}`)

                if (currentPrice == Infinity) {
                    this.stopMonitoringPairForPriceChange(pair)
                }
            }, intervalInSeconds * 1000);

            this.pairPriceMonitoringIntervals.set(pair.contract_addr, monitoringIntervalId);

            console.log(`Price - Monitoring started for ${pairName}.`);
        } catch (error) {
            console.error('Error monitoring pair:', error);
        }
    }

    stopMonitoringPairForPriceChange(pair) {
        let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`
        if (this.pairPriceMonitoringIntervals.has(pair.contract_addr)) {
            clearInterval(this.pairPriceMonitoringIntervals.get(pair.contract_addr));
            this.pairPriceMonitoringIntervals.delete(pair.contract_addr);

            console.log(`Monitoring stopped for ${pairName}.`);
        } else {
            console.log(`Pair ${pairName} is not being monitored.`);
        }
    }

    async monitorLowLiquidityPair(pair, intervalInSeconds, liquidityThreshold) {
        try {
            const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
            if (this.lowLiquidityPairMonitoringIntervals.has(pair.contract_addr)) {
                console.log(`Pair ${pairName} is already being monitored for low liquidity.`);
                return;
            }
            const monitoringIntervalId = setInterval(async () => {
                const updatedPair = await this.getPairInfo(pair.contract_addr);
                if (!updatedPair) return
                this.allPairs.set(pair.contract_addr, updatedPair)
                const currentLiquidity = await this.calculateLiquidity(updatedPair);
                console.log(`${pairName} liquidity: ${currentLiquidity}`)
                if (currentLiquidity && currentLiquidity > liquidityThreshold) {
                    this.stopMonitoringLowLiquidityPair(pair)
                    console.log(`Monitoring ${pairName} - Liquidity Added: $${currentLiquidity}`);
                    this.sendMessageToDiscord(`:eyes: ${pairName} - Liquidity Added: $${currentLiquidity}\n${pair.astroportLink}\n${pair.dexscreenerLink}\n<@352761566401265664>`)
                    await this.buyMemeToken(pair, this.snipeAmount)
                }
            }, intervalInSeconds * 1000);
            this.lowLiquidityPairMonitoringIntervals.set(pair.contract_addr, monitoringIntervalId);
            console.log(`Low Liquidity - Monitoring started for ${pairName}`);

        } catch (error) {
            console.error('Error monitoring low liquidity pair:', error);
        }
    }

    stopMonitoringLowLiquidityPair(pair) {
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
        const monitoringIntervalId = this.lowLiquidityPairMonitoringIntervals.get(pair.contract_addr);

        if (monitoringIntervalId) {
            clearInterval(monitoringIntervalId);
            this.lowLiquidityPairMonitoringIntervals.delete(pair.contract_addr);
            console.log(`Monitoring stopped for ${pairName} - Low Liquidity.`);
        } else {
            console.log(`Pair ${pairName} is not currently being monitored for low liquidity.`);
        }
    }

    async getPortfolio() {
        console.log("fetching portfolio")
        try {
            const endpoints = getNetworkEndpoints(Network.Mainnet);
            const indexerGrpcAccountPortfolioApi = new IndexerGrpcAccountPortfolioApi(
                endpoints.indexer,
            );

            const portfolio = await indexerGrpcAccountPortfolioApi.fetchAccountPortfolio(
                this.walletAddress,
            );

            for (const balance of portfolio.bankBalancesList) {
                try {
                    if (balance.denom === this.baseDenom || balance.amount <= 0) continue;

                    const pair = Array.from(this.allPairs.values()).find(pair => {
                        return (
                            pair.token0Meta.denom === balance.denom ||
                            pair.token1Meta.denom === balance.denom
                        );
                    });

                    if (!pair) continue;

                    const pairInfo = await this.getPairInfo(pair.contract_addr);
                    if (pairInfo) {
                        this.allPairs.set(pair.contract_addr, pairInfo)
                        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
                        const tokenDenom = pair.asset_infos[0].native_token.denom === balance.denom
                            ? pair.token0Meta
                            : pair.token1Meta;

                        const quote = await this.getSellQuoteFromRouter(pair, balance.amount);

                        if (quote) {
                            const amountBack = (quote.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(3);
                            const convertedQuote = quote.amount / Math.pow(10, this.baseAsset.decimals)
                            const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)
                            const usdValue = (convertedQuote * baseAssetPriceConverted)

                            if (!this.positions.has(pair.contract_addr)) {
                                this.positions.set(
                                    pair.contract_addr,
                                    {
                                        pair_contract: pair.contract_addr,
                                        balance: balance.amount,
                                        amount_in: this.snipeAmount * Math.pow(10, this.baseAsset ? this.baseAsset.decimals : 18),
                                        token_denom: tokenDenom.denom,
                                        profit: 0
                                    });
                            }

                            console.log(`found balance for ${pairName}: ${(balance.amount / Math.pow(10, tokenDenom.decimals)).toFixed(2)} ${tokenDenom.symbol} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)})`)

                            if (usdValue > 1) {
                                this.monitorPairToSell(pair, 10)
                            }
                        }
                    }
                } catch (error) {
                    console.error(`Error processing balance for ${balance.denom}:`, error.originalMessage ?? error);
                }
            }
            return portfolio
        } catch (error) {
            console.error('Error fetching account portfolio:', error);
        }
    }

    async updateLiquidityAllPairs() {
        console.log("update liquidity for all pairs")
        for (const pair of this.allPairs.values()) {
            await this.calculateLiquidity(pair);
            if (pair.liquidity < 10 && pair.liquidity > 0 && !this.positions.has(pair.contract_addr)) {
                this.allPairs.delete(pair.contract_addr)
                this.ignoredPairs.add(pair.contract_addr)
            }
        }
        await this.saveToFile('data.json')
    }

    async buyMemeToken(pair, amount, retries = 5) {
        if (!pair || !this.live) {
            console.error("Invalid pair or live trading not enabled");
            return;
        }

        const { token0Meta, token1Meta } = pair;
        const baseTokenMeta = token0Meta.denom === this.baseDenom ? token0Meta : token1Meta;
        const memeTokenMeta = token0Meta.denom === this.baseDenom ? token1Meta : token0Meta;

        console.log(`Attempting to buy ${memeTokenMeta.symbol}`);

        const adjustedAmount = amount * 10 ** (this.baseAsset ? this.baseAsset.decimals : 18);

        const swapOperations = {
            swap: {
                offer_asset: {
                    info: {
                        native_token: {
                            denom: baseTokenMeta.denom,
                        },
                    },
                    amount: adjustedAmount.toString(),
                },
                max_spread: this.maxSpread.toString(),
            },
        };

        const msg = MsgExecuteContractCompat.fromJSON({
            contractAddress: pair.contract_addr,
            sender: this.walletAddress,
            msg: swapOperations,
            funds: {
                denom: this.baseDenom,
                amount: adjustedAmount,
            },
        });

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const result = await this.txManager.enqueue(msg);
                if (result) {
                    console.log("Swap executed successfully:", result.txHash);

                    const returnAmount = this.parseReturnAmountFromEvents(result.rawLog);
                    if (returnAmount !== undefined) {
                        this.handleSuccessfulSwap(pair, returnAmount, adjustedAmount, memeTokenMeta);
                        await this.monitorPairToSell(pair, 10);
                    } else {
                        console.error("Return amount not found in events.");
                    }

                    return result;
                }
                console.log(`Buy attempt ${attempt} failed. Retrying...`);
            } catch (error) {
                console.error(`Error executing swap (attempt ${attempt}):`, error);
            }
        }

        console.error(`Failed to execute swap after ${retries} attempts.`);
    }

    parseReturnAmountFromEvents(rawLog) {
        const events = JSON.parse(rawLog)[0]?.events;
        if (!events) return undefined;

        const wasmEvent = events.find((event) => event.type === "wasm");
        if (!wasmEvent) return undefined;

        const returnAmountAttribute = wasmEvent.attributes.find((attr) => attr.key === "return_amount");
        console.log(`return amount ${returnAmountAttribute.value}`)
        return returnAmountAttribute ? returnAmountAttribute.value : undefined;
    }

    handleSuccessfulSwap(pair, returnAmount, adjustedAmount, memeTokenMeta) {
        const balance = this.positions.get(pair.contract_addr)?.balance || 0;
        const profit = this.positions.get(pair.contract_addr)?.profit || 0;
        const amountIn = this.positions.get(pair.contract_addr)?.amount_in || 0;

        console.log(`${memeTokenMeta.denom} existing balance ${balance}`)
        const updatedBalance = Number(balance) + Number(returnAmount);
        console.log(`${memeTokenMeta.denom} updated balance ${updatedBalance}`)

        this.positions.set(pair.contract_addr, {
            pair_contract: pair.contract_addr,
            balance: updatedBalance,
            amount_in: Number(amountIn) + Number(adjustedAmount),
            token_denom: memeTokenMeta.denom,
            time_bought: moment(),
            profit: profit
        });

        console.log(this.positions.get(pair.contract_addr))

        this.sendMessageToDiscord(`:gun: Sniped token ${memeTokenMeta.symbol}! ` +
            `Balance: ${(updatedBalance / 10 ** memeTokenMeta.decimals).toFixed(3)} ` +
            `<@352761566401265664>\n${pair.dexscreenerLink}`);
    }

    async sellMemeToken(pair, amount = null, maxRetries = 3) {
        if (!pair) {
            console.error("Invalid pair for sellMemeToken");
            return;
        }

        if (!this.live) {
            console.error("Live trading not enabled");
            return;
        }

        const baseDenom = this.baseDenom;
        const memeTokenMeta = pair.token0Meta.denom === baseDenom
            ? pair.token1Meta
            : pair.token0Meta;

        let position = this.positions.get(pair.contract_addr);

        if (!amount) {
            if (position) {
                console.log("get balance from positions")
                amount = this.positions.get(pair.contract_addr).balance;
            } else {
                console.log("get balance from bank")
                amount = await this.getBalanceOfToken(memeTokenMeta.denom).amount;
            }
        }

        if (!amount) {
            console.log(`No balance to sell for ${memeTokenMeta.symbol}`)
            return
        }

        amount = Math.round(amount)

        let spread = this.maxSpread
        // if (memeTokenMeta.symbol == "n/a") {
        //     amount = amount / Math.pow(10, memeTokenMeta.decimals)
        // }
        let retryCount = 0;
        while (retryCount < maxRetries) {
            // if (memeTokenMeta.symbol == "n/a") {
            //     const decimalPrecision = [6, 8, 18][retryCount];
            // }
            const swapOperations = {
                swap: {
                    offer_asset: {
                        info: {
                            native_token: {
                                denom: memeTokenMeta.denom,
                            },
                        },
                        amount: amount.toString(),
                    },
                    max_spread: spread.toString(),
                },
            };

            const msg = MsgExecuteContractCompat.fromJSON({
                contractAddress: pair.contract_addr,
                sender: this.walletAddress,
                msg: swapOperations,
                funds: {
                    denom: memeTokenMeta.denom,
                    amount: amount.toString(),
                },
            });

            try {
                let result = await this.txManager.enqueue(msg);

                if (!result) {
                    console.log("Sell failed");
                    retryCount += 1;
                    spread += 0.2
                }
                else {
                    this.stopMonitoringPairToSell(pair)

                    console.log("Swap executed successfully:", result.txHash);

                    let profit = 0
                    const returnAmount = this.parseReturnAmountFromEvents(result.rawLog);
                    if (returnAmount !== undefined) {
                        profit = returnAmount - position.amount_in
                    } else {
                        console.error("Return amount not found in sell events.");
                    }
                    this.positions.set(pair.contract_addr, {
                        ...position,
                        balance: Number(position.balance) - Number(amount),
                        profit: Number(position.profit) + Number(profit)
                    });

                    profit = (profit / Math.pow(10, this.baseAsset.decimals))
                    let returnAmountAdjusted = (returnAmount / Math.pow(10, this.baseAsset.decimals))

                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)
                    const usdValue = (profit * baseAssetPriceConverted)

                    this.sendMessageToDiscord(
                        `${profit > 0 ? ':dollar:' : ':small_red_triangle_down:'} ` +
                        `Sold token ${memeTokenMeta.symbol} for ${returnAmountAdjusted.toFixed(4)} ${this.baseAssetName}. ` +
                        `PnL: ${profit > 0 ? '+' : ''}${profit.toFixed(4)} ${this.baseAssetName} ($${usdValue.toFixed(2)}) <@352761566401265664>\n${pair.dexscreenerLink}`
                    );
                    return result;
                }
            } catch (error) {
                console.error(`Error executing swap (Attempt ${retryCount + 1}/${maxRetries}):`, error);
                retryCount += 1;
                spread += 0.2
            }
        }
        console.error(`Exceeded maximum retry attempts (${maxRetries}). Sell operation failed.`);

        return null
    }

    async formatPortfolioMessage(portfolio) {
        let formattedMessage = '';

        for (const balance of portfolio.bankBalancesList) {
            if (balance.denom === this.baseDenom || balance.amount <= 0) continue;

            const pair = Array.from(this.allPairs.values()).find(pair => {
                return (
                    pair.token0Meta.denom === balance.denom ||
                    pair.token1Meta.denom === balance.denom
                );
            });

            if (pair) {
                const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
                const tokenDenom = pair.asset_infos[0].native_token.denom === balance.denom
                    ? pair.token0Meta
                    : pair.token1Meta;

                const quote = await this.getSellQuoteFromRouter(pair, balance.amount);

                if (quote) {
                    const amountBack = (quote.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(3);
                    const convertedQuote = quote.amount / Math.pow(10, this.baseAsset.decimals)
                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)

                    const usdValue = (convertedQuote * baseAssetPriceConverted)

                    if (usdValue > 1) {
                        formattedMessage += `${pairName}: ${(balance.amount / Math.pow(10, tokenDenom.decimals)).toFixed(2)} ` +
                            `${tokenDenom.symbol} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)})\n${pair.dexscreenerLink}\n`;
                    }
                }
            }
        }

        return formattedMessage.trim();
    }

    async monitorPairToSell(pair, intervalInSeconds) {
        try {
            let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;

            if (this.sellPairPriceMonitoringIntervals.has(pair.contract_addr)) {
                console.log(`Pair ${pairName} is already being monitored to sell.`);
                return;
            }

            const monitoringIntervalId = setInterval(async () => {
                const updatedPair = await this.getPairInfo(pair.contract_addr);
                if (!updatedPair) return
                this.allPairs.set(pair.contract_addr, updatedPair)

                let position = this.positions.get(pair.contract_addr)

                const quote = await this.getSellQuoteFromRouter(updatedPair, position.balance);

                const tokenDenom = pair.token0Meta.denom === position.token_denom
                    ? pair.token0Meta
                    : pair.token1Meta;

                let result = null;

                let currentTime = moment()
                if (currentTime > moment(position.time_bought).add(this.tradeTimeLimit, 'minute')) {
                    console.log(`trade time limit reached (${this.tradeTimeLimit} minutes)`)
                    this.stopMonitoringPairToSell(pair)
                    result = await this.sellMemeToken(pair, position.balance)
                    return
                }

                if (quote) {
                    const percentageIncrease = ((quote.amount - position.amount_in) / position.amount_in) * 100;

                    if (percentageIncrease <= this.stopLoss * -1 && quote.amount < position.amount_in) {
                        console.log(`stop loss hit for ${tokenDenom.symbol} ${percentageIncrease}%`)
                        this.stopMonitoringPairToSell(pair)
                        result = await this.sellMemeToken(pair, position.balance)
                        return
                    }
                    if (percentageIncrease >= this.profitGoalPercent && quote.amount > position.amount_in) {
                        console.log(`profit goal reached for ${tokenDenom.symbol} ${percentageIncrease}%`)
                        this.stopMonitoringPairToSell(pair)
                        if (percentageIncrease >= this.profitGoalPercent * 2) {
                            result = await this.sellMemeToken(pair, Number(position.balance) * 0.6)
                        }
                        else {
                            result = await this.sellMemeToken(pair, Number(position.balance) * 0.85)
                        }
                        return result
                    }

                    const amountBack = (quote.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(3);
                    const convertedQuote = quote.amount / Math.pow(10, this.baseAsset.decimals)
                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)

                    const usdValue = (convertedQuote * baseAssetPriceConverted)
                    const convertedBalance = position.balance / Math.pow(10, tokenDenom.decimals)
                    const price = usdValue / convertedBalance

                    console.log(`${pairName}: balance: ${(convertedBalance).toFixed(2)} ${tokenDenom.symbol}, ` +
                        `price: $${price.toFixed(8)} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)}) ${percentageIncrease.toFixed(2)}%`)
                }
            }, intervalInSeconds * 1000);

            this.sellPairPriceMonitoringIntervals.set(pair.contract_addr, monitoringIntervalId);

            console.log(`Sell - Monitoring started for ${pairName}.`);
        } catch (error) {
            console.error('Error monitoring pair:', error);
        }
    }

    stopMonitoringPairToSell(pair) {
        let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`
        if (this.sellPairPriceMonitoringIntervals.has(pair.contract_addr)) {
            clearInterval(this.sellPairPriceMonitoringIntervals.get(pair.contract_addr));
            this.sellPairPriceMonitoringIntervals.delete(pair.contract_addr);

            console.log(`Monitoring to sell stopped for ${pairName}.`);
        } else {
            console.log(`Pair ${pairName} is not being monitored.`);
        }
    }

    async startMonitoringLowLiquidityPairs() {
        const lowLiquidityPairs = Array.from(this.allPairs.values()).filter(pair => {
            return pair.liquidity < this.lowLiquidityThreshold;
        });

        const lowLiquidityPollInterval = 30; // seconds
        for (const pair of lowLiquidityPairs) {
            await this.monitorLowLiquidityPair(
                pair,
                lowLiquidityPollInterval,
                this.lowLiquidityThreshold
            );
        }
    }

    async monitorPairs(pairsToMonitorPrice) {
        const pairsToMonitor = Array.from(this.allPairs.values()).filter(pair => {
            return (
                (pairsToMonitorPrice.includes(pair.token0Meta.symbol) || pairsToMonitorPrice.includes(pair.token1Meta.symbol)) &&
                pair.liquidity > this.lowLiquidityThreshold
            );
        });

        const trackingPollInterval = 10; // seconds
        const trackingPriceDuration = 5; // minutes
        const priceChangePercentNotificationThreshold = 5; // percent

        for (const pair of pairsToMonitor) {
            await this.monitorPairForPriceChange(
                pair,
                trackingPollInterval,
                trackingPriceDuration,
                priceChangePercentNotificationThreshold
            );
        }
    }

}

module.exports = AstroportSniper;