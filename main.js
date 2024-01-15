const InjectiveSniper = require("./modules/snipe")

const LIVE_TRADING = false

const CONFIG = {
    live: LIVE_TRADING,
    gRpc: "https://sentry.chain.grpc-web.injective.network",
    tokenTypes: ['native', 'tokenFactory', 'cw20'],
    pairType: '{"xyk":{}}',
    maxSpread: 0.49,
    snipeAmount: 0.4,                   // INJ
    profitGoalPercent: 40,              // %
    stopLoss: 80,                       // %
    moonBagPercent: 0.20,               // %
    tradeTimeLimit: 15,                 // mins
    lowLiquidityThreshold: 10000,       // USD
    highLiquidityThreshold: 100000,     // USD
}

const main = async () => {

    const injectiveSniper = new InjectiveSniper(CONFIG);
    injectiveSniper.startMonitoringBasePair(15);

    await injectiveSniper.initialize();
    await injectiveSniper.getPortfolio()

    injectiveSniper.setMonitorNewPairs(true)

};

main();
