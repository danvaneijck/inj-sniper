const AstroportSniper = require("./snipe")

const BACKFILL_PAIRS = false

const LIVE_TRADING = true

const CONFIG = {
    live: LIVE_TRADING,
    gRpc: "https://sentry.chain.grpc-web.injective.network",
    tokenTypes: ['native', 'tokenFactory'],
    pairType: '{"xyk":{}}',
    maxSpread: 0.49,
    snipeAmount: 0.1, // INJ
    profitGoalPercent: 20, // %
    stopLoss: 10, // %
    tradeTimeLimit: 5, // mins
    lowLiquidityThreshold: 1000, // USD
    highLiquidityThreshold: 100000 // USD
}

const main = async () => {

    const astroportSniper = new AstroportSniper(CONFIG);

    astroportSniper.startMonitoringBasePair(15); // track INJ price

    await astroportSniper.initialize(
        CONFIG.pairType,
        CONFIG.tokenTypes,
        BACKFILL_PAIRS
    );

    await astroportSniper.getPortfolio()

    // await astroportSniper.updateLiquidityAllPairs()
    console.log(`Number of pairs: ${astroportSniper.allPairs.size}`);

    astroportSniper.startMonitoringNewPairs(15);

    // const pair = await astroportSniper.getPairInfo("inj1kn45glfp303sc0zv4ye7ypd4ndvfsh5l7dcvas")
    // await astroportSniper.buyMemeToken(pair, CONFIG.snipeAmount)
    // await astroportSniper.monitorPairToSell(pair, 5)
    // await astroportSniper.sellMemeToken(pair)

};

main();
