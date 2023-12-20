const { ChainGrpcWasmApi, IndexerGrpcAccountPortfolioApi } = require('@injectivelabs/sdk-ts');
const { getNetworkEndpoints, Network } = require('@injectivelabs/networks');
const { DenomClientAsync } = require('@injectivelabs/sdk-ui-ts');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const moment = require('moment');
const fs = require('fs/promises');
require('dotenv').config();

class AstroportSniper {
    constructor(rpc, wallet) {
        console.log("init with ", rpc)

        this.chainGrpcWasmApi = new ChainGrpcWasmApi(rpc);
        this.astroFactory = process.env.FACTORY_CONTRACT;
        this.astroRouter = process.env.ROUTER_CONTRACT;
        this.pricePair = process.env.PRICE_PAIR_CONTRACT; // INJ / USDT

        this.walletAddress = wallet

        this.baseAssetName = "INJ"
        this.baseDenom = "inj"
        this.baseAsset = null
        this.stableAsset = null
        this.baseAssetPrice = 0;

        this.tokenTypes = ['native', 'tokenFactory'];
        this.pairType = '{"xyk":{}}';

        this.liquidityThreshold = 10000

        this.allPairs = [];
        this.ignoredPairs = [];

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
            });
        });

        this.allPairsQuery = {
            pairs: {
                start_after: [],
                limit: 10,
            },
        };
    }

    async initialize(pairType, tokenTypes) {
        this.pairType = pairType
        this.tokenTypes = tokenTypes

        await this.updateBaseAssetPrice()

        try {
            await this.loadFromFile('data.json');
            await this.getPairs(pairType, tokenTypes);

            this.setupDiscordCommands()

            // await this.updateLiquidityAllPairs()

            this.allPairs = this.allPairs.sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
            console.log(`Number of pairs: ${this.allPairs.length}`);

            // this.allPairs.forEach((pair) => {
            //     const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
            //     if (Math.round(pair.liquidity) > 0) console.log(`${pairName}: ${pair.astroportLink}, Liquidity: $${Math.round(pair.liquidity)}`);
            // });
        } catch (error) {
            console.error('Error during initialization:', error);
        }
    }

    async loadFromFile(filename) {
        try {
            const data = await fs.readFile(filename, 'utf-8');
            const jsonData = JSON.parse(data);

            if (jsonData.allPairs) {
                this.allPairs = jsonData.allPairs;
                console.log('Loaded allPairs from file');
            }

            if (jsonData.ignoredPairs) {
                this.ignoredPairs = jsonData.ignoredPairs;
                console.log('Loaded ignoredPairs from file');
            }
        } catch (error) {
            console.error('Error loading data from file:', error);
        }
    }

    async saveToFile(filename) {
        try {
            const dataToSave = {
                allPairs: this.allPairs,
                ignoredPairs: this.ignoredPairs,
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
        let quote = await this.getQuote(baseAssetPair)
        if (!quote) return
        this.baseAssetPrice = quote['return_amount']
        this.stableAsset = baseAssetPair.token0Meta
        this.baseAsset = baseAssetPair.token1Meta

        const currentPrice = quote['return_amount'] / Math.pow(10, this.stableAsset.decimals)
        if (this.discordClient && this.discordClient.user) {
            const activityText = `${this.baseAssetName}: $${currentPrice}`;
            this.discordClient.user.setActivity(activityText, { type: ActivityType.Watching });
        }
    }

    startMonitoringBasePair(intervalInSeconds) {
        console.log('Base Asset monitoring started.');
        this.monitoringBasePairIntervalId = setInterval(() => {
            this.updateBaseAssetPrice();
        }, intervalInSeconds * 1000);
    }

    stopMonitoringBasePair() {
        clearInterval(this.monitoringBasePairIntervalId);
        console.log('Base Asset monitoring stopped.');
    }

    async getPairs(pairType, tokenTypes) {
        try {
            const startTime = new Date().getTime(); // Record the start time
            let uniquePairs = new Set();
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

                await Promise.all(decodedJson.pairs.map(async (pair) => {
                    const pairKey = JSON.stringify(pair);
                    if (!uniquePairs.has(pairKey) && !this.ignoredPairs.some(ignoredPair => ignoredPair.contract_addr === pair.contract_addr)) {
                        if (!this.allPairs.some(existingPair => existingPair.contract_addr === pair.contract_addr)) {
                            console.log("get pair info for", pair.contract_addr)
                            let pairInfo = await this.getPairInfo(pair.contract_addr);

                            if (
                                pairInfo &&
                                pairInfo.token0Meta &&
                                pairInfo.token1Meta &&
                                tokenTypes.includes(pairInfo.token0Meta.tokenType) &&
                                tokenTypes.includes(pairInfo.token1Meta.tokenType) &&
                                pairType === JSON.stringify(pairInfo.pair_type) &&
                                (pairInfo.token0Meta.denom === this.baseDenom || pairInfo.token1Meta.denom === this.baseDenom)
                            ) {
                                uniquePairs.add(JSON.stringify({ ...pair, ...pairInfo }));
                                const message = `:new: New pair found: ${pairInfo.token0Meta.symbol}, ${pairInfo.token1Meta.symbol}: \n${pairInfo.astroportLink}\n${pairInfo.coinhallLink}\n <@352761566401265664>`;
                                console.log(message)
                                this.sendMessageToDiscord(message);
                                await this.calculateLiquidity({ ...pair, ...pairInfo })

                                if (pair.liquidity > this.liquidityThreshold) {
                                    await this.monitorPairForPriceChange({ ...pair, ...pairInfo }, 5, 5, 5)
                                }
                                else {
                                    await this.monitorLowLiquidityPair({ ...pair, ...pairInfo }, 10, 200)
                                }
                            }
                            else {
                                this.ignoredPairs.push(pair);
                            }
                        }
                    }
                }));

                const lastPair = decodedJson.pairs[decodedJson.pairs.length - 1];
                this.allPairsQuery.pairs.start_after = lastPair.asset_infos;

                previousPairs = decodedJson.pairs;
            }

            this.allPairs = this.allPairs.concat(Array.from(uniquePairs).map(pair => JSON.parse(pair)));

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
            const denomClient = new DenomClientAsync(Network.Mainnet, {})
            const token = await denomClient.getDenomToken(denom)
            return token;
        } catch (error) {
            console.error('Error fetching token info:', error);
        }
    }

    async getPairInfo(pairContract) {
        try {
            const pairQuery = Buffer.from(JSON.stringify({ pair: {} })).toString('base64');
            const poolQuery = Buffer.from(JSON.stringify({ pool: {} })).toString('base64');
            const configQuery = Buffer.from(JSON.stringify({ config: {} })).toString('base64');

            const [pairInfo, poolInfo, pairConfig] = await Promise.all([
                this.chainGrpcWasmApi.fetchSmartContractState(pairContract, pairQuery),
                this.chainGrpcWasmApi.fetchSmartContractState(pairContract, poolQuery),
                this.chainGrpcWasmApi.fetchSmartContractState(pairContract, configQuery),
            ]);

            const [infoDecoded, poolDecoded, decodedJson] = await Promise.all([
                JSON.parse(new TextDecoder().decode(pairInfo.data)),
                JSON.parse(new TextDecoder().decode(poolInfo.data)),
                JSON.parse(new TextDecoder().decode(pairConfig.data)),
            ]);

            const [token0Contract, token1Contract] = infoDecoded['asset_infos'].map((assetInfo) => {
                const contract = assetInfo['native_token'] ? assetInfo['native_token']['denom'] : assetInfo['token']['contract_addr'];
                return this.getTokenInfo(contract);
            });

            const [token0Info, token1Info] = await Promise.all([token0Contract, token1Contract]);
            if (!token0Info || !token1Info) return null

            const paramsDecoded = JSON.parse(atob(decodedJson.params));

            let liquidity = null
            if (this.baseAsset && this.stableAsset) {

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
                liquidity = numericBaseAssetAmount * baseAssetPrice;
                liquidity = (liquidity * 2) / Math.pow(10, this.stableAsset.decimals)
            }

            return {
                ...decodedJson,
                token0Meta: token0Info,
                token1Meta: token1Info,
                astroportLink: `https://app.astroport.fi/swap?from=${token0Info.denom}&to=${token1Info.denom}`,
                coinhallLink: `https://coinhall.org/injective/${pairContract}`,
                contract_addr: pairContract,
                pair_type: infoDecoded.pair_type,
                asset_infos: infoDecoded.asset_infos,
                pool: poolDecoded.assets,
                params: paramsDecoded,
                liquidity: liquidity,
                liquidityUpdated: moment()
            };
        } catch (error) {
            console.error(`Error fetching pair ${pairContract} info:`, error);
        }
    }

    async getQuote(pair) {
        if (!pair) return
        const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
        const simulationQuery = {
            simulation: {
                offer_asset: {
                    info: {
                        native_token: {
                            denom: 'inj'
                        }
                    },
                    amount: '1000000000000000000'
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

            const assetToSell = pair.asset_infos.findIndex(assetInfo => assetInfo.native_token.denom !== this.baseDenom);

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
                                offer_asset_info: {
                                    native_token: {
                                        denom: assetInfo.native_token.denom
                                    }
                                },
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
            let decodedData = await this.getQuote(pair)
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
                const currentLiquidity = await this.calculateLiquidity(updatedPair);
                if (currentLiquidity && currentLiquidity > liquidityThreshold) {
                    console.log(`Monitoring ${pairName} - Liquidity Added: $${currentLiquidity}`);
                    this.sendMessageToDiscord(`:eyes: ${pairName} - Liquidity Added: $${currentLiquidity}\n${pair.astroportLink}\n${pair.coinhallLink}\n<@352761566401265664>`)
                    this.stopMonitoringLowLiquidityPair(pair)
                    this.monitorPairForPriceChange(pair, 5, 5, 5)
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

    async getPortfolio(address) {
        try {
            const endpoints = getNetworkEndpoints(Network.Mainnet);
            const indexerGrpcAccountPortfolioApi = new IndexerGrpcAccountPortfolioApi(
                endpoints.indexer,
            );

            const portfolio = await indexerGrpcAccountPortfolioApi.fetchAccountPortfolio(
                address,
            );

            for (const balance of portfolio.bankBalancesList) {
                try {
                    if (balance.denom === this.baseDenom || balance.amount <= 0) continue;
                    let pair = this.allPairs.find(x => x.asset_infos[0].native_token.denom == balance.denom || x.asset_infos[1].native_token.denom == balance.denom);

                    if (!pair) continue;

                    const pairInfo = await this.getPairInfo(pair.contract_addr);
                    if (pairInfo) {
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

                            console.log(`found balance for ${pairName}: ${(balance.amount / Math.pow(10, tokenDenom.decimals)).toFixed(2)} ${tokenDenom.symbol} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)})`)
                            if (usdValue > 1) {
                                this.monitorPairToSell(pairInfo, balance, 5)
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
        for (const pair of this.allPairs) {
            await this.calculateLiquidity(pair);
        }
        await this.saveToFile('data.json')
    }

    async executePurchase(pair, amount, slippage, maxSpread) {
        console.log(JSON.stringify(pair, null, 2))
        if (!pair) {
            console.error("Invalid pair for executePurchase");
            return;
        }

        const baseDenom = this.baseDenom;

        const offerDenom = pair.asset_infos[0].native_token.denom === baseDenom
            ? pair.asset_infos[0].native_token.denom
            : pair.asset_infos[1].native_token.denom;

        const askDenom = pair.asset_infos[1].native_token.denom !== baseDenom
            ? pair.asset_infos[1].native_token.denom
            : pair.asset_infos[0].native_token.denom;


        const quote = await this.getQuoteFromRouter(pair, amount);

        if (!quote) {
            console.error("Failed to get quote for executePurchase");
            return;
        }

        const quotedAmount = quote['amount']
        const slippageFactor = 1 - slippage;
        const minimumReceive = (parseFloat(quotedAmount) * slippageFactor).toString();

        console.log(`quotedAmount :${quotedAmount}`)
        console.log(`minimumReceive :${minimumReceive}`)

        const swapOperations = {
            execute_swap_operations: {
                operations: [
                    {
                        native_swap: {
                            offer_denom: offerDenom,
                            ask_denom: askDenom
                        }
                    },
                    {
                        astro_swap: {
                            offer_asset_info: {
                                native_token: {
                                    denom: offerDenom
                                }
                            },
                            ask_asset_info: {
                                token: {
                                    contract_addr: askDenom
                                }
                            }
                        }
                    }
                ],
                minimum_receive: minimumReceive,
                to: this.walletAddress,
                max_spread: maxSpread
            }
        };
        return

        try {
            const query = Buffer.from(JSON.stringify(swapOperations)).toString('base64');
            const result = await this.chainGrpcWasmApi.executeSmartContract(this.astroRouter, query);
            console.log("Swap executed successfully:", result);
            return result;
        } catch (error) {
            console.error("Error executing swap:", error);
        }
    }

    setupDiscordCommands() {
        this.discordClient.on('interactionCreate', async interaction => {
            if (!interaction.isCommand()) return;
            const { commandName } = interaction;
            if (commandName === 'get_positions') {
                await interaction.reply("Fetching wallet holdings...");
                await this.executeGetPositionsCommand();
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

    async formatPortfolioMessage(portfolio) {
        let formattedMessage = '';

        for (const balance of portfolio.bankBalancesList) {
            if (balance.denom === this.baseDenom || balance.amount <= 0) continue;

            const pair = this.allPairs.find(
                x =>
                    x.asset_infos[0].native_token.denom === balance.denom ||
                    x.asset_infos[1].native_token.denom === balance.denom
            );

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
                        formattedMessage += `${pairName}: ${(balance.amount / Math.pow(10, tokenDenom.decimals)).toFixed(2)} ${tokenDenom.symbol} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)})\n`;
                    }
                }
            }
        }

        return formattedMessage.trim();
    }

    async monitorPairToSell(pair, balance, intervalInSeconds) {
        try {
            let pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;

            if (this.sellPairPriceMonitoringIntervals.has(pair.contract_addr)) {
                console.log(`Pair ${pairName} is already being monitored to sell.`);
                return;
            }

            const monitoringIntervalId = setInterval(async () => {
                const updatedPair = await this.getPairInfo(pair.contract_addr);
                if (!updatedPair) return

                const quote = await this.getSellQuoteFromRouter(updatedPair, balance.amount);

                const tokenDenom = pair.asset_infos[0].native_token.denom === balance.denom
                    ? pair.token0Meta
                    : pair.token1Meta;

                if (quote) {
                    const amountBack = (quote.amount / Math.pow(10, this.baseAsset.decimals)).toFixed(3);
                    const convertedQuote = quote.amount / Math.pow(10, this.baseAsset.decimals)
                    const baseAssetPriceConverted = this.baseAssetPrice / Math.pow(10, this.stableAsset.decimals)

                    const usdValue = (convertedQuote * baseAssetPriceConverted)
                    const convertedBalance = balance.amount / Math.pow(10, tokenDenom.decimals)
                    const price = usdValue / convertedBalance

                    console.log(`${pairName}: balance: ${(convertedBalance).toFixed(2)} ${tokenDenom.symbol}, price: $${price.toFixed(8)} (${amountBack} ${this.baseAssetName} $${usdValue.toFixed(2)})`)
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

    async startMonitoringLowLiquidityPairs(lowLiquidityThreshold) {

        const lowLiquidityPairs = this.allPairs.filter(pair => {
            return pair.liquidity < lowLiquidityThreshold;
        });

        const lowLiquidityPollInterval = 10; // seconds
        for (const pair of lowLiquidityPairs) {
            await his.monitorLowLiquidityPair(
                pair,
                lowLiquidityPollInterval,
                lowLiquidityThreshold
            );
        }
    }

    async monitorPairs(pairsToMonitorPrice) {
        const pairsToMonitor = this.allPairs.filter(pair => {
            return (pairsToMonitorPrice.includes(pair.token0Meta.symbol) || pairsToMonitorPrice.includes(pair.token1Meta.symbol)) && pair.liquidity > this.liquidityThreshold;
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