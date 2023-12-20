const {
    TxClient,
    TxGrpcClient,
    ChainRestAuthApi,
    createTransaction,
    MsgSend,
    BaseAccount,
    ChainRestTendermintApi
} = require('@injectivelabs/sdk-ts');
const { BigNumberInBase, DEFAULT_STD_FEE, DEFAULT_BLOCK_TIMEOUT_HEIGHT } = require('@injectivelabs/utils')

class TransactionManager {

    constructor(privateKey) {
        this.privateKey = privateKey
    }

    async signAndBroadcastTransaction(msg, memo = '') {
        try {
            const restEndpoint = "https://sentry.lcd.injective.network"
            const gRPC = "https://sentry.chain.grpc-web.injective.network"
            const chainId = "injective-1"

            const walletAddress = this.privateKey.toAddress().toBech32()
            const publicKey = this.privateKey.toPublicKey().toBase64();

            const chainRestAuthApi = new ChainRestAuthApi(restEndpoint)
            const accountDetailsResponse = await chainRestAuthApi.fetchAccount(
                walletAddress,
            )
            const baseAccount = BaseAccount.fromRestApi(accountDetailsResponse)

            const chainRestTendermintApi = new ChainRestTendermintApi(restEndpoint)
            const latestBlock = await chainRestTendermintApi.fetchLatestBlock()
            const latestHeight = latestBlock.header.height
            const timeoutHeight = new BigNumberInBase(latestHeight).plus(
                DEFAULT_BLOCK_TIMEOUT_HEIGHT,
            )

            const { signBytes, txRaw } = createTransaction({
                message: msg,
                memo: memo,
                fee: DEFAULT_STD_FEE,
                pubKey: publicKey,
                sequence: baseAccount.sequence,
                timeoutHeight: timeoutHeight.toNumber(),
                accountNumber: baseAccount.accountNumber,
                chainId: chainId,
            });

            const signature = await this.privateKey.sign(Buffer.from(signBytes));
            txRaw.signatures = [signature];

            console.log(`Transaction Hash: ${TxClient.hash(txRaw)}`);

            const txService = new TxGrpcClient(gRPC);

            const simulationResponse = await txService.simulate(txRaw);

            console.log(
                `Transaction simulation response: ${JSON.stringify(
                    simulationResponse.gasInfo,
                )}`,
            );

            const txResponse = await txService.broadcast(txRaw);

            if (txResponse.code !== 0) {
                console.log(`Transaction failed: ${txResponse.rawLog}`);
                return null
            } else {
                console.log(
                    `Broadcasted transaction hash: ${JSON.stringify(txResponse.txHash)}`,
                );
                return txResponse
            }
        } catch (error) {
            console.error(`Error in signAndBroadcastTransaction: ${error}`);
        }
    }
}

module.exports = TransactionManager