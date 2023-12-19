import {
    getNetworkInfo,
    Network,
    TxClient,
    PrivateKey,
    TxGrpcClient,
    ChainRestAuthApi,
    createTransaction,
    MsgSend,
    DEFAULT_STD_FEE,
    BigNumberInBase,
} from '@injectivelabs/sdk-ts';

class TransactionManager {
    constructor(network) {
        this.network = network;
    }

    async signAndBroadcastTransaction(privateKeyHash, msgJson, memo = '') {
        try {
            const privateKey = PrivateKey.fromHex(privateKeyHash);
            const injectiveAddress = privateKey.toBech32();
            const publicKey = privateKey.toPublicKey().toBase64();

            const accountDetails = await new ChainRestAuthApi(
                this.network.rest,
            ).fetchAccount(injectiveAddress);

            const msg = MsgSend.fromJSON(msgJson);

            const { signBytes, txRaw } = createTransaction({
                message: msg,
                memo: memo,
                fee: DEFAULT_STD_FEE,
                pubKey: publicKey,
                sequence: parseInt(accountDetails.account.base_account.sequence, 10),
                accountNumber: parseInt(
                    accountDetails.account.base_account.account_number,
                    10,
                ),
                chainId: this.network.chainId,
            });

            const signature = await privateKey.sign(Buffer.from(signBytes));
            txRaw.signatures = [signature];

            console.log(`Transaction Hash: ${TxClient.hash(txRaw)}`);

            const txService = new TxGrpcClient(this.network.grpc);

            const simulationResponse = await txService.simulate(txRaw);
            console.log(
                `Transaction simulation response: ${JSON.stringify(
                    simulationResponse.gasInfo,
                )}`,
            );

            const txResponse = await txService.broadcast(txRaw);

            if (txResponse.code !== 0) {
                console.log(`Transaction failed: ${txResponse.rawLog}`);
            } else {
                console.log(
                    `Broadcasted transaction hash: ${JSON.stringify(txResponse.txHash)}`,
                );
            }
        } catch (error) {
            console.error(`Error in signAndBroadcastTransaction: ${error}`);
        }
    }
}

export default TransactionManager