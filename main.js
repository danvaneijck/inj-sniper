const InjectiveSniper = require("./modules/snipe")
const { MAIN_NET, TEST_NET } = require("./constants")
const LIVE_TRADING = true


const CONFIG = {
    live: LIVE_TRADING,
    endpoints: MAIN_NET,
    tokenTypes: ['native', 'tokenFactory', 'cw20'],
    pairType: '{"xyk":{}}',
    maxSpread: 50,
    snipeAmount: 0.0001,                  // INJ
    profitGoalPercent: 500,             // %
    stopLoss: 95,                       // %
    moonBagPercent: 0.20,               // %
    tradeTimeLimit: 1000,               // mins
    lowLiquidityThreshold: 0.00001,     // USD
    highLiquidityThreshold: 100000,     // USD
    targetDenom: "factory/inj1sy2aad37tku3dz0353epczxd95hvuhzl0lhfqh/FUNNY" // token to snipe

    // targetDenom: "factory/inj18xsczx27lanjt40y9v79q0v57d76j2s8ctj85x/POOR" // token to snipe
}

const main = async () => {
    try {
        const injectiveSniper = new InjectiveSniper(CONFIG);
        injectiveSniper.startMonitoringBasePair(20);

        await injectiveSniper.initialize();
        await injectiveSniper.getPortfolio()

        await injectiveSniper.setMonitorNewPairs(true)

        // await injectiveSniper.startMonitorPairForLiq("inj1f9gnm2sf2s0rtvuk4ngr3uae9hrqe8k97n6m6y")

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
