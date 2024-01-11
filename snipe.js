const {
    ChainGrpcWasmApi,
    IndexerGrpcAccountPortfolioApi,
    PrivateKey,
    ChainGrpcBankApi,
    MsgExecuteContractCompat,
    IndexerGrpcExplorerStream,
    IndexerRestExplorerApi
} = require('@injectivelabs/sdk-ts');
const { getNetworkEndpoints, Network } = require('@injectivelabs/networks');
const { DenomClientAsync } = require('@injectivelabs/sdk-ui-ts');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const moment = require('moment');
const fs = require('fs/promises');
const TransactionManager = require("./transactions")
var colors = require("colors");
colors.enable();
require('dotenv').config();

class AstroportSniper {
    constructor(config) {
        this.RPC = config.gRpc
        this.live = config.live

        console.log(`Init on ${this.RPC}`.bgGreen)

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
        this.indexerRestExplorerApi = new IndexerRestExplorerApi(
            `${getNetworkEndpoints(Network.Mainnet).explorer}/api/explorer/v1`,
        )
        this.indexerRestExplorerApi.fetchTransactions({

        })

        this.monitorNewPairs = false

        this.privateKey = PrivateKey.fromMnemonic(process.env.MNEMONIC)
        this.publicKey = this.privateKey.toAddress()

        this.walletAddress = this.privateKey.toAddress().toBech32()
        console.log(`Loaded wallet from private key ${this.walletAddress}`.bgGreen)

        this.txManager = new TransactionManager(this.privateKey)

        this.baseAssetName = "INJ"
        this.baseDenom = "inj"
        this.baseAsset = null
        this.stableAsset = null
        this.baseAssetPrice = 0;
        this.moonBagPercent = config.moonBagPercent

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

        this.lowLiqPairsToMonitor = new Set()

        this.monitoringNewPairIntervalId = null;
        this.monitoringBasePairIntervalId = null;

        this.discordToken = process.env.DISCORD_TOKEN;
        this.discordChannelId = process.env.DISCORD_CHANNEL;

        this.discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
        this.discordTag = `<@352761566401265664>`

        this.allPairsQuery = {
            pairs: {
                start_after: [],
                limit: 50,
            },
        };
    }

    async initialize(pairType, tokenTypes, backfill = false) {
        try {
            this.pairType = pairType
            this.tokenTypes = tokenTypes

            if (backfill) {
                this.live = false
            }
            try {
                await this.loadFromFile('data.json');
                await this.updateBaseAssetPrice()
                this.setupDiscordCommands()
            } catch (error) {
                console.error('Error during initialization:', error);
            }

            this.discordClient.on('ready', async () => {
                console.log(`Logged in as ${this.discordClient.user.tag}!`.gray);
                await this.sendMessageToDiscord(
                    `:arrows_clockwise: Start up INJ Sniper on RPC: ${this.RPC}\n` +
                    `:chart_with_upwards_trend: Trading mode: ${this.live ? ':exclamation: LIVE :exclamation:' : 'TEST'}\n` +
                    `:gun: Snipe amount: ${this.snipeAmount} ${this.baseAssetName} ($${((this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)) * this.snipeAmount).toFixed(2)}), ` +
                    `profit goal: ${(this.profitGoalPercent).toFixed(2)}%, stop loss: ${(this.stopLoss).toFixed(2)}%,` +
                    ` targeting pairs between $${this.lowLiquidityThreshold} and $${this.highLiquidityThreshold} in liquidity`
                )
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
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('monitor_to_sell')
                        .addStringOption(option => option.setName('pair').setDescription('The pair to monitor').setRequired(true))
                        .setDescription('Monitor a pair for opportunity to sell')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('set_live_trading')
                        .addBooleanOption(option => option.setName('live').setDescription('Is trading live?').setRequired(true))
                        .setDescription('Set live trading mode on or off')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('set_monitor_new_pairs')
                        .addBooleanOption(option => option.setName('monitor_pairs').setDescription('Monitor for new pairs?').setRequired(true))
                        .setDescription('Set monitoring for new pairs on or off')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('start_monitor_pair_for_liquidity')
                        .addStringOption(option => option.setName('pair').setDescription('The pair to monitor').setRequired(true))
                        .setDescription('Monitor a pair for added liquidity')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('stop_monitor_pair_for_liquidity')
                        .addStringOption(option => option.setName('pair').setDescription('The pair to stop monitoring').setRequired(true))
                        .setDescription('Stop monitoring a pair for added liquidity')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('set_config')
                        .addNumberOption(option => option.setName('snipe_amount').setDescription('The snipe amount').setRequired(true))
                        .addNumberOption(option => option.setName('stop_loss').setDescription('The stop loss % 1 - 100').setRequired(true))
                        .addNumberOption(option => option.setName('profit_goal').setDescription('The profit goal % 1 - 100').setRequired(true))
                        .addNumberOption(option => option.setName('moon_bag').setDescription('The moon bag % 0.0 - 1.0').setRequired(true))
                        .addNumberOption(option => option.setName('low_liq_threshold').setDescription('The low liquidity threshold $').setRequired(true))
                        .addNumberOption(option => option.setName('high_liq_threshold').setDescription('The high liquidity threshold $').setRequired(true))
                        .addNumberOption(option => option.setName('trade_time_limit').setDescription('The trade time limit in minutes').setRequired(true))
                        .setDescription('Set the trading parameters')
                    );
                    guild.commands.create(new SlashCommandBuilder()
                        .setName('get_status')
                        .setDescription('Get the current bot status')
                    );
                });
                console.log("set up discord slash commands".gray)
            });
            this.discordClient.login(this.discordToken);
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
            if (commandName === 'monitor_to_sell') {
                await interaction.reply("Monitoring token to sell");
                const pairContract = interaction.options.getString('pair');
                await this.executeMonitorToSellCommand(pairContract);
            }
            if (commandName === 'set_live_trading') {
                const live = interaction.options.getBoolean('live');
                this.live = live
                await interaction.reply(`Set live trading to ${live}`);
            }
            if (commandName === 'set_monitor_new_pairs') {
                const monitor_pairs = interaction.options.getBoolean('monitor_pairs');
                this.setMonitorNewPairs(monitor_pairs)
                await interaction.reply(`Set monitor new pairs to ${monitor_pairs}`);
            }
            if (commandName === 'start_monitor_pair_for_liquidity') {
                const pairContract = interaction.options.getString('pair');
                this.startMonitorPairForLiq(pairContract)
                let pair = await this.getPairInfo(pairContract)
                const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
                await interaction.reply(`:arrow_forward: Began monitoring ${pairName} for liquidity`);
            }
            if (commandName === 'stop_monitor_pair_for_liquidity') {
                const pairContract = interaction.options.getString('pair');
                this.stopMonitorPairForLiq(pairContract)
                let pair = await this.getPairInfo(pairContract)
                const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
                await interaction.reply(`:stop_button: Stopped monitoring ${pairName} for liquidity`);
            }
            if (commandName === 'set_config') {
                const snipeAmount = interaction.options.getNumber('snipe_amount');
                const profitGoal = interaction.options.getNumber('stop_loss');
                const stopLoss = interaction.options.getNumber('profit_goal');
                const moonBagPercent = interaction.options.getNumber('moon_bag');
                const lowLiq = interaction.options.getNumber('low_liq_threshold');
                const highLiq = interaction.options.getNumber('high_liq_threshold');
                const timeLimit = interaction.options.getNumber('trade_time_limit');

                this.snipeAmount = snipeAmount
                this.profitGoalPercent = profitGoal
                this.stopLoss = stopLoss
                this.moonBagPercent = moonBagPercent
                this.lowLiquidityThreshold = lowLiq
                this.highLiquidityThreshold = highLiq
                this.tradeTimeLimit = timeLimit

                let message =
                    `:gun: Snipe amount: ${this.snipeAmount} ${this.baseAssetName} ($${((this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)) * this.snipeAmount).toFixed(2)})\n` +
                    `:moneybag: Profit goal: ${this.profitGoalPercent}% :octagonal_sign: Stop loss: ${this.stopLoss}% :crescent_moon: Moon bag: ${this.moonBagPercent}\n` +
                    `:arrow_down_small: Low liquidity threshold: $${this.lowLiquidityThreshold} :arrow_up_small: High liquidity threshold: $${this.highLiquidityThreshold}\n` +
                    `:alarm_clock: Time limit: ${this.tradeTimeLimit} mins\n\n` +
                    `Trading live: ${this.live ? ":white_check_mark:" : ":x:"}\n` +
                    `Monitoring new pairs: ${this.monitorNewPairs ? ":white_check_mark:" : ":x:"}\n`

                await interaction.reply(message);
            }
            if (commandName === 'get_status') {
                let liqMonitor = ""
                for (const pair of this.lowLiqPairsToMonitor.values()) {
                    let pairInfo = await this.getPairInfo(pair)
                    let pairName = `${pairInfo.token0Meta.symbol}, ${pairInfo.token1Meta.symbol}`;
                    liqMonitor += `${pairName} (${pair}), `
                }

                let message =
                    `:gun: Snipe amount: ${this.snipeAmount} ${this.baseAssetName} ($${((this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)) * this.snipeAmount).toFixed(2)})\n` +
                    `:moneybag: Profit goal: ${this.profitGoalPercent}% :octagonal_sign: Stop loss: ${this.stopLoss}% :crescent_moon: Moon bag: ${this.moonBagPercent}\n` +
                    `:arrow_down_small: Low liquidity threshold: $${this.lowLiquidityThreshold} :arrow_up_small: High liquidity threshold: $${this.highLiquidityThreshold}\n` +
                    `:alarm_clock: Time limit: ${this.tradeTimeLimit} mins\n\n` +
                    `Trading live: ${this.live ? ":white_check_mark:" : ":x:"}\n` +
                    `Monitoring new pairs: ${this.monitorNewPairs ? ":white_check_mark:" : ":x:"}\n` +
                    `Monitoring pairs for liquidity: ${liqMonitor.length > 0 ? liqMonitor : "none"}\n`

                await interaction.reply(message);
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
            const memeTokenMeta = pair.token0Meta.denom === this.baseDenom
                ? pair.token1Meta
                : pair.token0Meta;
            let balance = await this.getBalanceOfToken(memeTokenMeta.denom);
            if (balance) {
                let result = await this.sellMemeToken(pair, balance.amount)
                if (result && !this.allPairs.has(pairContract)) {
                    this.allPairs.set(pairContract, pair);
                    this.ignoredPairs.delete(pairContract);
                }
            }

        } catch (error) {
            console.error('Error executing /sell_token command:', error);
            await this.sendMessageToDiscord('Error executing /sell_token command')
        }
    }

    async executeMonitorToSellCommand(pairContract) {
        try {
            let pair = await this.getPairInfo(pairContract)
            await this.monitorPairToSell(pair, 5)
            if (pair && !this.allPairs.has(pairContract)) {
                this.allPairs.set(pairContract, pair);
                this.ignoredPairs.delete(pairContract);
            }
        } catch (error) {
            console.error('Error executing /monitor_to_sell command:', error);
            await this.sendMessageToDiscord('Error executing /monitor_to_sell command')
        }
    }

    async loadFromFile(filename) {
        try {
            const data = await fs.readFile(filename, 'utf-8');
            const jsonData = JSON.parse(data);
            if (jsonData.allPairs) {
                this.allPairs = new Map(jsonData.allPairs.map(pair => [pair.contract_addr, pair]));
                console.log('Loaded allPairs from file'.gray);
            }
            if (jsonData.positions) {
                this.positions = new Map(jsonData.positions.map(position => [position.pair_contract, position]));
                console.log('Loaded positions from file'.gray);
            }
            if (jsonData.ignoredPairs) {
                this.ignoredPairs = new Set(jsonData.ignoredPairs);
                console.log('Loaded ignoredPairs from file'.gray);
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
            const activityText = `${this.baseAssetName}: $${currentPrice.toFixed(2)}`;
            this.discordClient.user.setActivity(activityText, { type: ActivityType.Watching });
        }
        await this.saveToFile('data.json')
    }

    startMonitoringBasePair(intervalInSeconds) {
        console.log('Base Asset monitoring started.'.gray);
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
                                    await this.monitorLowLiquidityPair({ ...pair, ...pairInfo }, 2, this.lowLiquidityThreshold);
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
            // console.log(`Finished check for new pairs in ${executionTime} milliseconds`);
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

    async getContractHistory(pairContract) {
        const contractHistory = await this.chainGrpcWasmApi.fetchContractHistory(
            pairContract
        )
        console.log(contractHistory)
        contractHistory.entriesList.map((item) => {
            console.log(new TextDecoder().decode(item.msg))
        })
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
                    ...infoDecoded
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
        const askAssetIndex = pair.asset_infos.findIndex(assetInfo => {
            const isNativeToken = assetInfo.native_token && assetInfo.native_token.denom !== this.baseDenom;
            const isCW20Token = assetInfo.token && assetInfo.token.contract_addr !== this.baseTokenContractAddr;
            return isNativeToken || isCW20Token;
        });
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

    startMonitoringNewPairsOld(intervalInSeconds) {
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

            // console.log(`pool decoded ${JSON.stringify(poolDecoded, null, 2)}`)

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

                if (pair.liquidity < 1) {
                    let message = `:small_red_triangle_down: ${pairName} rugged!`
                    this.sendMessageToDiscord(message);
                }
                else {
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
                }


                console.log(`${pairName} price ${parseFloat(currentPrice).toFixed(10)}, liquidity: $${Math.round(pair.liquidity)}`.yellow)

                if (currentPrice == Infinity || pair.liquidity < 1) {
                    this.stopMonitoringPairForPriceChange(pair)
                }
            }, intervalInSeconds * 1000);

            this.pairPriceMonitoringIntervals.set(pair.contract_addr, monitoringIntervalId);

            console.log(`Price - Monitoring started for ${pairName}.`.bgCyan);
        } catch (error) {
            console.error('Error monitoring pair:', error);
        }
    }

    stopMonitoringPairForPriceChange(pair) {
        let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`
        if (this.pairPriceMonitoringIntervals.has(pair.contract_addr)) {
            clearInterval(this.pairPriceMonitoringIntervals.get(pair.contract_addr));
            this.pairPriceMonitoringIntervals.delete(pair.contract_addr);

            console.log(`Monitoring stopped for ${pairName}.`.bgYellow);
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
                console.log(`${pairName} liquidity: ${currentLiquidity}`.gray)
                if (currentLiquidity && currentLiquidity > liquidityThreshold) {
                    this.stopMonitoringLowLiquidityPair(pair)
                    console.log(`Monitoring ${pairName} - Liquidity Added: $${currentLiquidity}`);
                    this.sendMessageToDiscord(`:eyes: ${pairName} - Liquidity Added: $${currentLiquidity}\n${pair.astroportLink}\n${pair.dexscreenerLink}\n<@352761566401265664>`)
                    await this.buyMemeToken(pair, this.snipeAmount)
                }
            }, intervalInSeconds * 1000);
            this.lowLiquidityPairMonitoringIntervals.set(pair.contract_addr, monitoringIntervalId);
            console.log(`Low Liquidity - Monitoring started for ${pairName}`.bgCyan);

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
            console.log(`Monitoring stopped for ${pairName} - Low Liquidity.`.bgYellow);
        } else {
            console.log(`Pair ${pairName} is not currently being monitored for low liquidity.`);
        }
    }

    async getPortfolio() {
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
                    await this.calculateLiquidity(pairInfo)
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
                                        amount_in: 0,
                                        token_denom: tokenDenom.denom,
                                        profit: 0,
                                        is_moon_bag: true
                                    });
                            }

                            console.log(`found balance for ${pairName}: ${(balance.amount / Math.pow(10, tokenDenom.decimals)).toFixed(2)} ${tokenDenom.symbol} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)})`.yellow)

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
        console.log("update liquidity for all pairs".bgCyan)
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
            profit: profit,
            is_moon_bag: false
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

        const memeTokenMeta = pair.token0Meta.denom === this.baseDenom
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
                    if (!amount) {
                        console.log("refreshing balance, attempting sell again")
                        amount = await this.getBalanceOfToken(memeTokenMeta.denom).amount;
                        amount = Math.round(amount)
                    }
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

                    let updatedBalance = Number(position.balance) - Number(amount)
                    let updatedAmountIn = Number(position.amount_in) - Number(returnAmount)
                    if (updatedAmountIn < 0) {
                        updatedAmountIn = 0
                    }

                    this.positions.set(pair.contract_addr, {
                        ...position,
                        amount_in: updatedAmountIn,
                        balance: updatedBalance,
                        profit: Number(position.profit) + Number(profit),
                        is_moon_bag: updatedBalance > 0 && updatedAmountIn == 0
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
        this.sendMessageToDiscord(`Failed to sell token ${memeTokenMeta.symbol} ${pair.dexscreenerLink} ${this.discordTag}`)

        return null
    }

    async formatPortfolioMessage(portfolio) {
        let formattedMessage = '';

        for (const balance of portfolio.bankBalancesList) {
            if (Number(balance.amount) <= 0 || !balance.amount) continue;

            if (balance.denom === this.baseDenom) {
                let usdValue = (this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)) * (balance.amount / Math.pow(10, this.baseAsset.decimals))
                formattedMessage += `${this.baseAssetName}: ${(balance.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(2)} :dollar: $${usdValue.toFixed(2)}\n`
                continue
            }

            const pair = Array.from(this.allPairs.values()).find(pair => {
                return (
                    pair.token0Meta.denom === balance.denom ||
                    pair.token1Meta.denom === balance.denom
                );
            });

            if (pair) {
                const tokenDenom = pair.asset_infos[0].native_token.denom === balance.denom
                    ? pair.token0Meta
                    : pair.token1Meta;

                const quote = await this.getSellQuoteFromRouter(pair, balance.amount);

                if (quote) {
                    const amountBack = (quote.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(3);
                    const convertedQuote = quote.amount / Math.pow(10, this.baseAsset.decimals)
                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)

                    const usdValue = (convertedQuote * baseAssetPriceConverted)

                    if (usdValue.toFixed(2) > 0) {
                        formattedMessage += `${(balance.amount / Math.pow(10, tokenDenom.decimals)).toFixed(2)} ` +
                            `${tokenDenom.symbol} (${amountBack} ${this.baseAssetName} :dollar: $${usdValue.toFixed(2)}) ` +
                            `liquidity: $${pair.liquidity.toFixed(2)} ${pair.dexscreenerLink}\n`;
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
                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)
                    const convertedQuote = quote.amount / Math.pow(10, this.baseAsset.decimals)
                    const amountBack = (quote.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(3);
                    const usdValue = (convertedQuote * baseAssetPriceConverted)
                    const convertedBalance = position.balance / Math.pow(10, tokenDenom.decimals)
                    const price = usdValue / convertedBalance

                    const moonBagGoal = Math.round((this.snipeAmount * 5) * Math.pow(10, this.baseAsset.decimals))

                    if (position.is_moon_bag && Number(quote.amount) > Number(moonBagGoal)) {
                        console.log(`taking profit on moon bag for ${tokenDenom.symbol}`)
                        this.stopMonitoringPairToSell(pair)
                        result = await this.sellMemeToken(pair, position.balance)
                        return
                    }
                    if (position.is_moon_bag) {
                        console.log(`${pairName} moon bag balance: ${(convertedBalance).toFixed(2)} ${tokenDenom.symbol}, ` +
                            `price: $${price.toFixed(8)} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)})`)
                        return
                    }

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
                            result = await this.sellMemeToken(pair, Number(position.balance) * (1 - this.moonBagPercent))
                        }
                        return result
                    }

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

    startStreamingTransactions() {
        const endpoints = getNetworkEndpoints(Network.Mainnet)
        const indexerGrpcExplorerStream = new IndexerGrpcExplorerStream(
            endpoints.indexer,
        )

        const streamFn = indexerGrpcExplorerStream.streamTransactions.bind(
            indexerGrpcExplorerStream,
        )

        const callback = async (transaction) => {
            console.log(transaction)


        }

        const streamFnArgs = {
            callback,
        }

        streamFn(streamFnArgs)
    }

    async getTxByHash(txHash) {
        const txsHash = txHash
        const transaction = await this.indexerRestExplorerApi.fetchTransaction(txsHash)
        return transaction
    }

    async checkFactoryForNewPairs() {
        const startTime = new Date().getTime();

        const contractAddress = this.astroFactory;
        const limit = 5;
        const skip = 0;

        const transactions = await this.indexerRestExplorerApi.fetchContractTransactions({
            contractAddress,
            params: {
                limit,
                skip,
            },
        });

        await Promise.all(
            transactions.transactions.map(async (tx) => {
                const txHash = tx.txHash;
                let txInfo = await this.getTxByHash(txHash);
                if (!txInfo || !txInfo.logs) {
                    console.log(txInfo)
                    return
                }
                await Promise.all(
                    txInfo.messages.map(async (msg) => {
                        let message;
                        try {
                            message = JSON.parse(msg.message.msg);
                        } catch (error) {
                            message = msg.message.msg;
                        }
                        if (typeof message === 'object') {
                            const firstKey = Object.keys(message)[0];
                            if (firstKey == "create_pair") {
                                const blockTimestamp = txInfo['blockTimestamp'];

                                const pairAddress = txInfo.logs[0].events[txInfo.logs[0].events.length - 1].attributes.find((attr) => attr.key === "pair_contract_addr").value;

                                if (!this.allPairs.has(pairAddress) && !this.ignoredPairs.has(pairAddress)) {
                                    console.log("get pair info for", pairAddress);
                                    let pairInfo = await this.getPairInfo(pairAddress);

                                    if (
                                        pairInfo &&
                                        pairInfo.token0Meta &&
                                        pairInfo.token1Meta &&
                                        this.tokenTypes.includes(pairInfo.token0Meta.tokenType) &&
                                        this.tokenTypes.includes(pairInfo.token1Meta.tokenType) &&
                                        this.pairType === JSON.stringify(pairInfo.pair_type) &&
                                        (pairInfo.token0Meta.denom === this.baseDenom ||
                                            pairInfo.token1Meta.denom === this.baseDenom)
                                    ) {
                                        this.allPairs.set(pairAddress, { ...pairInfo });
                                        const message = `:new: New pair found from tx: ${pairInfo.token0Meta.symbol}, ` +
                                            `${pairInfo.token1Meta.symbol}: \n${pairInfo.astroportLink}\n` +
                                            `${pairInfo.dexscreenerLink}\n <@352761566401265664>`;

                                        this.sendMessageToDiscord(message);
                                        await this.calculateLiquidity(pairInfo);
                                        console.log(`${pairAddress} liquidity: ${pairInfo.liquidity}`)

                                        if (pairInfo.liquidity > this.lowLiquidityThreshold &&
                                            pairInfo.liquidity < this.highLiquidityThreshold) {
                                            await this.buyMemeToken(pairInfo, this.snipeAmount);
                                        } else {
                                            this.startMonitorPairForLiq(pairAddress);
                                        }
                                    } else {
                                        console.log(`Ignored pair ${pairAddress}, ${JSON.stringify(pairInfo, null, 2)}`);
                                        this.sendMessageToDiscord(`Ignored new pair https://dexscreener.com/injective/${pairAddress}`);

                                        this.ignoredPairs.add(pairAddress);
                                    }
                                }
                            }
                        }
                    })
                );
            })
        );

        const endTime = new Date().getTime();
        const executionTime = endTime - startTime;
        // console.log(`Finished check for new pairs in ${executionTime} milliseconds`);
    }

    async checkPairForProvideLiquidity(pairContract) {
        let pair = await this.getPairInfo(pairContract)
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;

        const startTime = new Date().getTime();
        const contractAddress = pairContract;
        let limit = 100;
        let skip = 0;

        let allTransactions = [];
        let transactions = await this.indexerRestExplorerApi.fetchContractTransactions({
            contractAddress,
            params: {
                limit,
                skip,
            },
        });

        try {
            // console.log(`total tx for ${pairName} : ${transactions.paging.total}`);
            do {
                const currentTransactions = transactions.transactions || [];
                allTransactions.push(...currentTransactions);

                if (currentTransactions.length == 0) {
                    break
                }

                let toSkip = (skip + limit) > transactions.paging.total ? transactions.paging.total - skip : limit;
                skip += Number(toSkip);
                skip = Math.min(skip, 10000);

                transactions = await this.indexerRestExplorerApi.fetchContractTransactions({
                    contractAddress,
                    params: {
                        limit,
                        skip,
                    },
                });
            } while (allTransactions.length < transactions.paging.total);
        } catch (error) {
            console.error("An error occurred getting pair transactions:", error);
            // console.log(transactions);
        }

        await Promise.all(
            allTransactions.map(async (tx) => {
                const txHash = tx.txHash;
                const txInfo = await this.getTxByHash(txHash);
                await Promise.all(
                    txInfo.messages.map(async (msg) => {
                        let message;
                        try {
                            message = JSON.parse(msg.message.msg);
                        } catch (error) {
                            message = msg.message.msg;
                        }

                        if (typeof message === 'object' && message.provide_liquidity) {
                            let baseAssetAmount;

                            if (message.provide_liquidity && message.provide_liquidity.pair_msg && message.provide_liquidity.pair_msg.provide_liquidity) {
                                const info = message.provide_liquidity.pair_msg.provide_liquidity;
                                baseAssetAmount = info.assets[0].info.native_token.denom === this.baseDenom ?
                                    info.assets[0].amount : info.assets[1].amount;
                            } else if (message.provide_liquidity && message.provide_liquidity.assets) {
                                const info = message.provide_liquidity;
                                baseAssetAmount = info.assets[0].info.native_token.denom === this.baseDenom ?
                                    info.assets[0].amount : info.assets[1].amount;
                            } else {
                                baseAssetAmount = 0;
                            }

                            const numericBaseAssetAmount = Number(baseAssetAmount) / 10 ** (this.baseAsset.decimals || 0);
                            const liquidity = (numericBaseAssetAmount * this.baseAssetPrice * 2) / 10 ** this.stableAsset.decimals;
                            const txTime = moment(txInfo['blockTimestamp'], 'YYYY-MM-DD HH:mm:ss.SSS Z');
                            console.log(`${pairName} liquidity added: $${liquidity} ${txTime.fromNow()}`);

                            if (txTime < moment().subtract(15, 'minute')) {
                                console.log(`liq added over time limit: ${txTime.fromNow()}`)
                                this.stopMonitorPairForLiq(pairContract);
                                return
                            }

                            if (
                                liquidity > 1 && liquidity < this.lowLiquidityThreshold &&
                                txTime > moment().subtract(1, 'minute')
                            ) {
                                this.stopMonitorPairForLiq(pairContract);
                                console.log("small amount of liquidity added")
                                this.sendMessageToDiscord(`:eyes: ${pairName} - Small liquidity Added: $${liquidity}\n` +
                                    `<t:${txTime.unix()}:R>\n` +
                                    `${pair.astroportLink}\n${pair.dexscreenerLink}\n<@352761566401265664>`)
                                await this.monitorPairForPriceChange(pair, 5, 5, 5)
                                return;
                            }

                            if (
                                liquidity > this.lowLiquidityThreshold &&
                                liquidity < this.highLiquidityThreshold &&
                                txTime > moment().subtract(1, 'minute')
                            ) {
                                this.stopMonitorPairForLiq(pairContract);
                                this.sendMessageToDiscord(`:eyes: ${pairName} - Liquidity Added from tx: $${liquidity}\n` +
                                    `<t:${txTime.unix()}:R>\n` +
                                    `${pair.astroportLink}\n${pair.dexscreenerLink}\n<@352761566401265664>`)


                                if (this.live) {
                                    await this.buyMemeToken(pair, this.snipeAmount);
                                }
                                else {
                                    this.monitorPairForPriceChange(pair, 10, 10, 5)
                                }

                                return;
                            }
                        }
                    })
                );
            })
        );

        const endTime = new Date().getTime();
        const executionTime = endTime - startTime;
        console.log(`Finished check for liq for pair ${pairName} in ${executionTime} milliseconds`);
    }

    startMonitorPairForLiq(pair) {
        this.lowLiqPairsToMonitor.add(pair)
        if (this.lowLiqPairsToMonitor.size == 1) {
            this.liquidityLoop()
        }
    }

    stopMonitorPairForLiq(pair) {
        this.lowLiqPairsToMonitor.delete(pair)
    }

    async liquidityLoop() {
        console.log(`liquidity loop: ${this.lowLiqPairsToMonitor.size > 0}`);

        while (this.lowLiqPairsToMonitor.size > 0) {
            for (const pair of this.lowLiqPairsToMonitor.values()) {
                await this.checkPairForProvideLiquidity(pair);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    setMonitorNewPairs(monitor) {
        this.monitorNewPairs = monitor
        console.log(`new pairs loop: ${this.monitorNewPairs}`.bgCyan)
        if (monitor) {
            this.sendMessageToDiscord(':dart: Begin monitoring for new Astroport pairs')
            this.newPairsLoop()
        }
        else {
            this.sendMessageToDiscord(':pause_button: Stop monitoring for new Astroport pairs')
        }
    }

    async newPairsLoop() {
        while (this.monitorNewPairs) {
            await this.checkFactoryForNewPairs();
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

}

module.exports = AstroportSniper;