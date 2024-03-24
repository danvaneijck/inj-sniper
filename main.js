const InjectiveSniper = require("./modules/snipe")

const LIVE_TRADING = false

const CONFIG = {
    live: LIVE_TRADING,
    gRpc: "https://sentry.chain.grpc-web.injective.network",
    tokenTypes: ['native', 'tokenFactory', 'cw20'],
    pairType: '{"xyk":{}}',
    maxSpread: 0.49,
    snipeAmount: 5,                     // INJ
    profitGoalPercent: 500,             // %
    stopLoss: 95,                       // %
    moonBagPercent: 0.20,               // %
    tradeTimeLimit: 1000,               // mins
    lowLiquidityThreshold: 10000,       // USD
    highLiquidityThreshold: 100000,     // USD
}

const main = async () => {
    try {
        const injectiveSniper = new InjectiveSniper(CONFIG);
        injectiveSniper.startMonitoringBasePair(10);

        await injectiveSniper.initialize();
        await injectiveSniper.getPortfolio()

        await injectiveSniper.setMonitorNewPairs(true)

    } catch (error) {
        console.error("An error occurred:", error);
    }
};

const start = async () => {
    let shouldRestart = true;

    while (shouldRestart) {
        try {
            await main();
            shouldRestart = false;
        } catch (error) {
            console.error("An error occurred:", error);
            console.log("RESTART".bgRed)
            shouldRestart = true;
        }
    }
};

start();
