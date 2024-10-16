const { Network } = require('@injectivelabs/networks');
const { PrivateKey, MsgExecuteContract, MsgBroadcasterWithPk, MsgExecuteContractCompat } = require("@injectivelabs/sdk-ts");
require("dotenv").config();

const main = async () => {
    const network = Network.Mainnet;

    const dojoFactory = "inj1pc2vxcmnyzawnwkf03n2ggvt997avtuwagqngk"
    const privateKey = PrivateKey.fromMnemonic(process.env.SNIPER_MNEMONIC);
    const sourceAddress = privateKey.toAddress().toBech32();
    const denom = "factory/inj1sy2aad37tku3dz0353epczxd95hvuhzl0lhfqh/FUNNY"

    try {
        // const msg = MsgExecuteContract.fromJSON({
        //     contractAddress: dojoFactory,
        //     sender: sourceAddress,
        //     msg: {
        //         create_pair: {
        //             assets: [
        //                 {
        //                     info: {
        //                         native_token: {
        //                             denom: "inj",
        //                         },
        //                     },
        //                     amount: "0",
        //                 },
        //                 {
        //                     info: {
        //                         native_token: {
        //                             denom: denom
        //                         },
        //                     },
        //                     amount: "0",
        //                 },
        //             ],
        //         },
        //     },
        // });

        const msg = MsgExecuteContractCompat.fromJSON({
            sender: sourceAddress,
            contractAddress: "inj1f9gnm2sf2s0rtvuk4ngr3uae9hrqe8k97n6m6y",
            msg: {
                provide_liquidity: {
                    assets: [
                        {
                            info: {
                                native_token: {
                                    denom: denom
                                },
                            },
                            amount: "500000000000",
                        },
                        {
                            info: {
                                native_token: {
                                    denom: "inj",
                                },
                            },
                            amount: "10000000000000000",
                        },
                    ],
                },
            },
            funds: [
                { denom: "inj", amount: "10000000000000000" },
                { denom: denom, amount: "500000000000" }
            ],
        });

        const broadcaster = new MsgBroadcasterWithPk({
            privateKey: privateKey,
            network: network,
            simulateTx: true,
        });

        const send = await broadcaster.broadcast({
            msgs: [msg],
        });

        if (send) {
            console.log(`Transaction Hash:`, send.txhash);
        }

    } catch (error) {
        console.error("An error occurred:", error);
    }
};

const start = async () => {
    await main();
};

start();
