const {
    TxClient,
    TxGrpcClient,
    ChainRestAuthApi,
    createTransaction,
    BaseAccount,
    ChainRestTendermintApi
} = require('@injectivelabs/sdk-ts');
const { BigNumberInBase, DEFAULT_STD_FEE, DEFAULT_BLOCK_TIMEOUT_HEIGHT } = require('@injectivelabs/utils')


const GAS = {
    ...DEFAULT_STD_FEE,
    gas: '300000'
}

class TransactionManager {

    constructor(privateKey, endpoints) {
        this.endpoints = endpoints
        this.privateKey = privateKey
        this.queue = [];
        this.isProcessing = false;
    }

    enqueue(message, gas = GAS) {
        return new Promise((resolve, reject) => {
            this.queue.push({ transaction: message, gas, resolve, reject });

            if (!this.isProcessing) {
                this.processQueue();
            }
        });
    }

    dequeue() {
        return this.queue.shift();
    }

    processQueue() {
        if (!this.isProcessing && this.queue.length > 0) {
            this.isProcessing = true;

            const { transaction, gas, resolve, reject } = this.dequeue();

            this.signAndBroadcastTransaction(transaction, gas)
                .then((txResponse) => {
                    resolve(txResponse);
                    this.isProcessing = false;
                    this.processQueue();
                })
                .catch((error) => {
                    reject(null);
                    console.error('Transaction failed:', error);
                    this.isProcessing = false;
                    this.processQueue();
                });
        }
    }

    async signAndBroadcastTransaction(msg, gas = GAS, memo = '') {
        try {
            const restEndpoint = this.endpoints.rest
            const gRPC = this.endpoints.grpc

            const chainId = gRPC.includes("testnet") ? "injective-888" : "injective-1"

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
                fee: gas,
                pubKey: publicKey,
                sequence: baseAccount.sequence,
                timeoutHeight: timeoutHeight.toNumber(),
                accountNumber: baseAccount.accountNumber,
                chainId: chainId,
            });

            const signature = await this.privateKey.sign(Buffer.from(signBytes));
            txRaw.signatures = [signature];

            // console.log(`Transaction Hash: ${TxClient.hash(txRaw)}`);

            const txService = new TxGrpcClient(gRPC);

            // console.log("simulate tx")
            const simulationResponse = await txService.simulate(txRaw);

            // console.log(
            //     `Transaction simulation response: ${JSON.stringify(
            //         simulationResponse.gasInfo,
            //     )}`,
            // );

            const txResponse = await txService.broadcast(txRaw);

            if (txResponse.code !== 0) {
                console.log(`Transaction failed: ${txResponse.rawLog}`);
                return null
            } else {
                // console.log(
                //     `Broadcasted transaction hash: ${JSON.stringify(txResponse.txHash)}`,
                // );
                return txResponse
            }
        } catch (error) {
            console.error(`Error in signAndBroadcastTransaction: ${error}`);
        }
    }
}

module.exports = TransactionManager