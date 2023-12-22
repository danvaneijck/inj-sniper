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
    profitGoalPercent: 40, // %
    stopLoss: 50, // %
    tradeTimeLimit: 60, // mins
    lowLiquidityThreshold: 1000, // USD
    highLiquidityThreshold: 100000 // USD
}

const main = async () => {

    const astroportSniper = new AstroportSniper(CONFIG);
    astroportSniper.startMonitoringBasePair(15);

    await astroportSniper.initialize(
        CONFIG.pairType,
        CONFIG.tokenTypes,
        BACKFILL_PAIRS
    );
    await astroportSniper.getPortfolio()

    // await astroportSniper.updateLiquidityAllPairs()
    console.log(`Number of pairs: ${astroportSniper.allPairs.size}`);

    astroportSniper.startMonitoringNewPairs(15);
};

main();
