const AstroportSniper = require("./snipe")

const main = async () => {
    const config = {
        live: false,
        maxSpread: 0.49,
        snipeAmount: 0.01,
        lowLiquidityThreshold: 5000,
        highLiquidityThreshold: 100000
    }

    const RPC = "https://sentry.chain.grpc-web.injective.network"

    const astroportSniper = new AstroportSniper(RPC, config);

    astroportSniper.startMonitoringBasePair(30); // track INJ price

    const tokenTypes = ['native', 'tokenFactory'];
    const pairType = '{"xyk":{}}';
    await astroportSniper.initialize(pairType, tokenTypes); // get token list

    await astroportSniper.updateLiquidityAllPairs()

    astroportSniper.startMonitoringNewPairs(10); // monitor for new tokens

    await astroportSniper.getPortfolio()

    // await astroportSniper.startMonitoringLowLiquidityPairs()

    // let pairToSell = await astroportSniper.getPairInfo("inj1lzgs9sx54g7p6xu28nkycj42kt2emexpay32lt")
    // await astroportSniper.sellMemeToken(pairToSell, null, config.maxSpread)

    // pairToSell = await astroportSniper.getPairInfo("inj1lmr5qlz3przfvccrsrff2ufvv33wujkgj8alhf")
    // await astroportSniper.sellMemeToken(pairToSell, null, config.maxSpread)
};

main();
