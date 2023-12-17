const { ChainGrpcWasmApi } = require('@injectivelabs/sdk-ts');
const { getNetworkEndpoints, Network } = require('@injectivelabs/networks');
const { DenomClientAsync } = require('@injectivelabs/sdk-ui-ts');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const moment = require('moment');
require('dotenv').config();


class AstroportSniper {
    constructor() {
        this.chainGrpcWasmApi = new ChainGrpcWasmApi(getNetworkEndpoints(Network.Mainnet).grpc);
        this.astroFactory = process.env.FACTORY_CONTRACT;
        this.astroRouter = process.env.ROUTER_CONTRACT;
        this.pricePair = process.env.PRICE_PAIR_CONTRACT; // INJ / USDT

        this.baseAssetName = "INJ"
        this.baseDenom = "inj"
        this.baseAsset = null
        this.stableAsset = null
        this.baseAssetPrice = 0;

        this.allPairs = [];
        this.pairPriceMonitoringIntervals = new Map();
        this.lowLiquidityPairMonitoringIntervals = new Map();

        this.lastPrices = new Map();

        this.monitoringNewPairIntervalId = null;
        this.monitoringBasePairIntervalId = null;

        this.discordToken = process.env.DISCORD_TOKEN;
        this.discordChannelId = process.env.DISCORD_CHANNEL;

        this.discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
        this.discordClient.login(this.discordToken);

        this.discordClient.on('ready', () => {
            console.log(`Logged in as ${this.discordClient.user.tag}!`);
        });

        this.allPairsQuery = {
            pairs: {
                start_after: [],
                limit: 10,
            },
        };
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
                    if (!uniquePairs.has(pairKey)) {
                        let pairInfo = await this.getPairInfo(pair.contract_addr);

                        if (pairInfo && pairInfo.token0Meta && pairInfo.token1Meta) {
                            if (
                                tokenTypes.includes(pairInfo.token0Meta.tokenType) &&
                                tokenTypes.includes(pairInfo.token1Meta.tokenType) &&
                                pairType === JSON.stringify(pairInfo.pair_type) &&
                                (pairInfo.token0Meta.denom === this.baseDenom || pairInfo.token1Meta.denom === this.baseDenom)
                            ) {
                                uniquePairs.add(JSON.stringify({ ...pair, ...pairInfo }));
                            }
                        }
                    }
                }));

                const lastPair = decodedJson.pairs[decodedJson.pairs.length - 1];
                this.allPairsQuery.pairs.start_after = lastPair.asset_infos;

                previousPairs = decodedJson.pairs;
            }

            return Array.from(uniquePairs).map(pair => JSON.parse(pair));
        } catch (error) {
            console.error('Error fetching all astro port pairs:', error);
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
                await this.checkForNewPairs();
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
            console.error('Error calculating market cap:', error);
            return null;
        }
    }

    async checkForNewPairs() {
        this.allPairsQuery.pairs.start_after = this.allPairs[this.allPairs.length - 1].asset_infos;
        const newPairs = await this.getPairs('{"xyk":{}}', ['native', 'tokenFactory']);
        const addedPairs = newPairs.filter((newPair) => !this.allPairs.some((existingPair) => existingPair.contract_addr === newPair.contract_addr));

        if (addedPairs.length > 0) {
            console.log(`Found ${addedPairs.length} new pair(s):`);
            addedPairs.forEach(async (pair) => {
                const message = `:new: New pair found: ${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}: ${pair.astroportLink} <@352761566401265664>`;
                this.sendMessageToDiscord(message);
                this.calculateLiquidity(pair)
                if (pair.liquidity > this.liquidityThreshold) {
                    await this.monitorPairForPriceChange(pair, 5, 5, 5)
                }
                else {
                    this.monitorLowLiquidityPair(pair, 10, 200)
                }
            });
            this.allPairs = [...this.allPairs, ...addedPairs];
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
                const quote = await this.getQuote(updatedPair);
                const currentPrice = this.baseAssetPrice / quote['return_amount'];

                lastPrices.push(currentPrice);
                lastPrices = lastPrices.slice(-trackingDurationMinutes * 60 / intervalInSeconds);

                const newHighestPrice = Math.max(...lastPrices, 0);
                const newLowestPrice = Math.min(...lastPrices, Infinity);

                const priceChangeToHighest = ((currentPrice - newHighestPrice) / newHighestPrice) * 100;
                const priceChangeToLowest = ((currentPrice - newLowestPrice) / newLowestPrice) * 100;

                if (Math.abs(priceChangeToHighest) > priceChangeThreshold) {
                    await this.calculateLiquidity(pair)
                    let message = `:small_red_triangle_down: ${pairName} Price is down ${parseFloat(priceChangeToHighest).toFixed(2)}% in the last ` +
                        `${trackingDurationMinutes} minutes. current: $${parseFloat(currentPrice).toFixed(10)}, ` +
                        `high: $${newHighestPrice.toFixed(10)}, liquidity: $${Math.round(pair.liquidity)}\n` +
                        `${pair.coinhallLink} / ${pair.astroportLink}`
                    this.sendMessageToDiscord(message);
                    this.lastPrices.delete(pair.contract_addr);
                    lastPrices = [];
                }

                if (priceChangeToLowest > priceChangeThreshold) {
                    await this.calculateLiquidity(pair)
                    let message = `:green_circle: ${pairName} price is up ${parseFloat(priceChangeToLowest).toFixed(2)}% in the last ` +
                        `${trackingDurationMinutes} minutes. current: $${parseFloat(currentPrice).toFixed(10)}, ` +
                        `low: $${newLowestPrice.toFixed(10)}, liquidity: $${Math.round(pair.liquidity)}\n` +
                        `${pair.coinhallLink} / ${pair.astroportLink}`;
                    this.sendMessageToDiscord(message);
                    this.lastPrices.delete(pair.contract_addr);
                    lastPrices = [];
                }
                console.log(`${pairName} price ${parseFloat(currentPrice).toFixed(10)}`)
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
                    this.sendMessageToDiscord(`:eyes: Monitoring ${pairName} - Liquidity Added: $${currentLiquidity} <@352761566401265664>\n${pair.astroportLink}`)
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

    async initialize(pairType, tokenTypes) {
        await this.updateBaseAssetPrice()
        try {
            this.allPairs = await this.getPairs(pairType, tokenTypes);

            this.allPairs = this.allPairs.sort((a, b) => {
                if (a.liquidity !== null && b.liquidity !== null) {
                    return b.liquidity - a.liquidity;
                } else if (a.liquidity !== null) {
                    return -1;
                } else if (b.liquidity !== null) {
                    return 1;
                }
                return 0;
            });

            console.log(`Number of pairs: ${this.allPairs.length}`);

            this.allPairs.forEach((pair) => {
                const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
                console.log(`${pairName}: ${pair.coinhallLink} ${pair.astroportLink}, Liquidity: $${Math.round(pair.liquidity)}`);
            });
        } catch (error) {
            console.error('Error during initialization:', error);
        }
    }
}

const main = async () => {
    const astroportSniper = new AstroportSniper();

    astroportSniper.startMonitoringBasePair(5); // track INJ price

    const tokenTypes = ['native', 'tokenFactory'];
    const pairType = '{"xyk":{}}';
    await astroportSniper.initialize(pairType, tokenTypes); // get token list

    astroportSniper.startMonitoringNewPairs(10); // monitor for new tokens

    const lowLiquidityThreshold = 1000; // USD
    const lowLiquidityPairs = astroportSniper.allPairs.filter(pair => {
        return pair.liquidity < lowLiquidityThreshold;
    });

    const lowLiquidityPollInterval = 10; // seconds

    for (const pair of lowLiquidityPairs) {
        await astroportSniper.monitorLowLiquidityPair(
            pair,
            lowLiquidityPollInterval,
            lowLiquidityThreshold
        );
    }

    const pairs = ['THUG', 'GRINJ', 'YUKI'];
    const pairsToMonitor = astroportSniper.allPairs.filter(pair => {
        return (pairs.includes(pair.token0Meta.symbol) || pairs.includes(pair.token1Meta.symbol)) && pair.liquidity > lowLiquidityThreshold;
    });

    const trackingPollInterval = 5; // seconds
    const trackingPriceDuration = 5; // minutes
    const priceChangePercentNotificationThreshold = 5; // percent

    for (const pair of pairsToMonitor) {
        await astroportSniper.monitorPairForPriceChange(
            pair,
            trackingPollInterval,
            trackingPriceDuration,
            priceChangePercentNotificationThreshold
        );
    }
};

main();
