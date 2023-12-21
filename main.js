const AstroportSniper = require("./snipe")

const main = async () => {

    const config = {
        live: true,
        maxSpread: 0.49,
        snipeAmount: 0.1,
        profitGoalPercent: 20,
        lowLiquidityThreshold: 1000,
        highLiquidityThreshold: 100000
    }

    const RPC = "https://sentry.chain.grpc-web.injective.network"

    const astroportSniper = new AstroportSniper(RPC, config);

    astroportSniper.startMonitoringBasePair(15); // track INJ price

    const tokenTypes = ['native', 'tokenFactory'];
    const pairType = '{"xyk":{}}';

    await astroportSniper.initialize(pairType, tokenTypes); // get token list

    // await astroportSniper.updateLiquidityAllPairs()

    astroportSniper.startMonitoringNewPairs(15); // monitor for new tokens

    await astroportSniper.getPortfolio()

    const pairToBuy = await astroportSniper.getPairInfo("inj1lxwe2enwcaffnpzu950rvg59sz6h0pzxk36gcc")
    await astroportSniper.buyMemeToken(pairToBuy, config.snipeAmount)

    // const sortedPairsArray = Array.from(astroportSniper.allPairs.entries()).sort(
    //     ([, pairA], [, pairB]) => (pairB.liquidity ?? 0) - (pairA.liquidity ?? 0)
    // );
    // astroportSniper.allPairs = new Map(sortedPairsArray);
    // console.log(`Number of pairs: ${astroportSniper.allPairs.size}`);

    // astroportSniper.allPairs.forEach((pair) => {
    //     const pairName = `${pair.token0Meta.symbol}, ${pair.token1Meta.symbol}`;
    //     if (Math.round(pair.liquidity) > 0) console.log(`${pairName}: ${pair.astroportLink}, Liquidity: $${Math.round(pair.liquidity)}`);
    // });

};

main();
