const AstroportSniper = require("./snipe")

const main = async () => {
    // const RPC = getNetworkEndpoints(Network.Mainnet).grpc
    const RPC = "https://sentry.chain.grpc-web.injective.network"

    const wallet = "inj1lq9wn94d49tt7gc834cxkm0j5kwlwu4gm65lhe"

    const astroportSniper = new AstroportSniper(RPC, wallet);

    astroportSniper.startMonitoringBasePair(5); // track INJ price

    const tokenTypes = ['native', 'tokenFactory'];
    const pairType = '{"xyk":{}}';
    await astroportSniper.initialize(pairType, tokenTypes); // get token list

    astroportSniper.startMonitoringNewPairs(15); // monitor for new tokens

    await astroportSniper.getPortfolio(wallet)

    const lowLiquidityThreshold = 10000; // USD


    // let pairToBuy = await astroportSniper.getPairInfo("inj1atyz3wxcaxdmhudpmpwgruqrp2yll83k47h4lz")
    // astroportSniper.executePurchase(pairToBuy, 0.01, 0.1, 0.1)
};

main();
