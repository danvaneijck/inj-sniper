const AstroportSniper = require("./snipe")

const CONFIG = {
    live: true,
    gRpc: "https://sentry.chain.grpc-web.injective.network",
    tokenTypes: ['native', 'tokenFactory'],
    pairType: '{"xyk":{}}',
    maxSpread: 0.2, // 20%
    snipeAmount: 0.1, // INJ
    profitGoalPercent: 10, // %
    tradeTimeLimit: 5, // mins
    lowLiquidityThreshold: 1000, // USD
    highLiquidityThreshold: 100000 // USD
}

const BACKFILL_PAIRS = false


const main = async () => {

    const astroportSniper = new AstroportSniper(CONFIG);

    astroportSniper.startMonitoringBasePair(15); // track INJ price

    await astroportSniper.initialize(
        CONFIG.pairType,
        CONFIG.tokenTypes,
        BACKFILL_PAIRS
    );

    // await astroportSniper.updateLiquidityAllPairs()
    console.log(`Number of pairs: ${astroportSniper.allPairs.size}`);

    astroportSniper.startMonitoringNewPairs(20); // monitor for new tokens

    await astroportSniper.getPortfolio()

    const pair = await astroportSniper.getPairInfo("inj1kxlaeevaqy24ug54seqqetpl8cunsskzhdtcxh")
    // await astroportSniper.buyMemeToken(pair, CONFIG.snipeAmount)
    // await astroportSniper.monitorPairToSell(pair, 5)
    // await astroportSniper.sellMemeToken(pair)

};

main();
