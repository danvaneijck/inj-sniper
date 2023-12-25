const AstroportSniper = require("./snipe")

const BACKFILL_PAIRS = false

const LIVE_TRADING = true

const CONFIG = {
    live: LIVE_TRADING,
    gRpc: "https://sentry.chain.grpc-web.injective.network",
    tokenTypes: ['native', 'tokenFactory', 'cw20'],
    pairType: '{"xyk":{}}',
    maxSpread: 0.49,
    snipeAmount: 0.6, // INJ
    profitGoalPercent: 40, // %
    stopLoss: 30, // %
    tradeTimeLimit: 600, // mins
    lowLiquidityThreshold: 1000, // USD
    highLiquidityThreshold: 100000, // USD
    blackList: ['inj16g5w38hqehsmye9yavag0g0tw7u8pjuzep0sys'] // LP holders to not trust
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
    // astroportSniper.getPairHistory("inj1t9y6d6vfa3hdquny43tckdz94kue6htxh2axef")
};

main();
