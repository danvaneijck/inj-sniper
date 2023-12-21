const AstroportSniper = require("./snipe")

const main = async () => {

    const config = {
        live: false,
        maxSpread: 0.49,
        snipeAmount: 0.01,
        lowLiquidityThreshold: 1000,
        highLiquidityThreshold: 100000
    }

    const RPC = "https://sentry.chain.grpc-web.injective.network"

    const astroportSniper = new AstroportSniper(RPC, config);

    astroportSniper.startMonitoringBasePair(30); // track INJ price

    const tokenTypes = ['native', 'tokenFactory'];
    const pairType = '{"xyk":{}}';

    await astroportSniper.initialize(pairType, tokenTypes); // get token list

    await astroportSniper.updateLiquidityAllPairs()

    astroportSniper.startMonitoringNewPairs(15); // monitor for new tokens

    await astroportSniper.getPortfolio()

    // await astroportSniper.startMonitoringLowLiquidityPairs()

    // let pairToSell = await astroportSniper.getPairInfo("inj1lzgs9sx54g7p6xu28nkycj42kt2emexpay32lt")
    // await astroportSniper.sellMemeToken(pairToSell, null, config.maxSpread)

    // pairToSell = await astroportSniper.getPairInfo("inj1lmr5qlz3przfvccrsrff2ufvv33wujkgj8alhf")
    // await astroportSniper.sellMemeToken(pairToSell, null, config.maxSpread)

    // let decode = astroportSniper.decodeReceipt('12360A342F696E6A6563746976652E7761736D782E76312E4D736745786563757465436F6E7472616374436F6D706174526573706F6E7365')
    // console.log(decode)
};

main();
