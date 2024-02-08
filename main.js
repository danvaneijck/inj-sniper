const InjectiveSniper = require("./modules/snipe")

const LIVE_TRADING = true

const CONFIG = {
    live: LIVE_TRADING,
    gRpc: "https://sentry.chain.grpc-web.injective.network",
    tokenTypes: ['native', 'tokenFactory', 'cw20'],
    pairType: '{"xyk":{}}',
    maxSpread: 0.49,
    snipeAmount: 0.1,                   // INJ
    profitGoalPercent: 40,              // %
    stopLoss: 80,                       // %
    moonBagPercent: 0.20,               // %
    tradeTimeLimit: 15,                 // mins
    lowLiquidityThreshold: 500,         // USD
    highLiquidityThreshold: 100000,     // USD
}

const main = async () => {

    const injectiveSniper = new InjectiveSniper(CONFIG);
    injectiveSniper.startMonitoringBasePair(10);

    await injectiveSniper.initialize();
    await injectiveSniper.getPortfolio()

    injectiveSniper.setMonitorNewPairs(true)

    // let pair = await injectiveSniper.getPairInfo("inj194zp3wnyd48cvlpa2nudq4w349a2cwsk2rug7p")
    // console.log(JSON.stringify(pair, null, 2))
    // injectiveSniper.monitorPairForPriceChange(pair, 5, 5, 5)

};

main();
