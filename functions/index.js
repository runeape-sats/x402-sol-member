const cors = require("cors")({ origin: true });

const functions = require("firebase-functions/v1");
const {
  Connection,
  PublicKey,
  Transaction: solTransaction,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
} = require("@solana/spl-token");

/*───────────────────────────────────────────────────────────────────────────*/
// 🔍  Core verification & settlement helpers
/*───────────────────────────────────────────────────────────────────────────*/

/**
 * Checks if the fee payer is a member based on SPL token balance.
 * @param {Connection} connection - Solana connection instance.
 * @param {PublicKey} feePayer - The public key of the fee payer.
 * @returns {boolean} True if the balance exceeds the required amount.
 */
const checkMembership = async (connection, feePayer) => {
  // Retrieve the member SPL token mint address from Firebase config
  const memberSpl = functions.config().solana.memberspl;

  // Get the required balance from config
  const memberSplReq = Number(functions.config().solana.membersplreq);

  // Get all token accounts owned by the fee payer
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
    feePayer,
    { programId: TOKEN_PROGRAM_ID },
  );
  // Find the token account for the member SPL token
  const tokenAccount = tokenAccounts.value.find(
    (account) => account.account.data.parsed.info.mint === memberSpl,
  );
  // If no token account found, not a member
  if (!tokenAccount) return false;
  // Get the token balance
  const balance = Number(
    tokenAccount.account.data.parsed.info.tokenAmount.uiAmount,
  );

  // Check if balance exceeds requirement
  return balance >= memberSplReq;
};

/**
 * Verifies the Solana transaction details against the payment requirements.
 * @param {Transaction} tx - The Solana transaction object.
 * @param {object} req - The payment requirement object.
 * @returns {PublicKey} The fee payer's public key.
 * @throws {Error} If transaction details don't match requirements.
 */
const verifyTransaction = (tx, req) => {
  // Extract payment details from requirements
  const PRICE = Number(req.maxAmountRequired);
  const USDC_MINT = new PublicKey(req.asset);
  const MERCHANT_TOKEN_ACCOUNT = new PublicKey(req.payTo);

  // Find the token transfer instruction in the transaction
  const transferIx = tx.instructions.find(
    (ix) => ix.programId.toString() === TOKEN_PROGRAM_ID.toString(),
  );
  if (!transferIx) throw new Error("No Token transferChecked in tx");

  // Parse the transfer instruction
  const parsed = decodeTransferCheckedInstruction(transferIx);
  if (!parsed) throw new Error("Instruction is not transferChecked");

  // Extract transfer details
  const {
    data: { amount, decimals },
    keys,
  } = parsed;
  const destinationPubkey = keys.destination.pubkey;
  const mintPubkey = keys.mint.pubkey;

  // Validate token decimals (USDC has 6)
  if (decimals !== 6) throw new Error("Token decimals must be 6");
  // Validate transfer amount
  if (Number(amount) !== PRICE)
    throw new Error(`Incorrect amount – expected ${PRICE}, got ${amount}`);
  // Validate destination account
  if (!destinationPubkey.equals(MERCHANT_TOKEN_ACCOUNT))
    throw new Error("Funds not going to the merchant account");
  // Validate token mint
  if (!mintPubkey.equals(USDC_MINT)) throw new Error("Wrong token mint");

  // Get fee payer and check signature
  const feePayer = tx.feePayer;
  const feePayerSig = tx.signatures.find(
    (sig) => feePayer && sig.publicKey.equals(feePayer),
  );
  if (!feePayerSig || !feePayerSig.signature) {
    throw new Error("Buyer (fee payer) signature missing");
  }

  return feePayer;
};

/**
 * Main function to verify and settle an x402 payment.
 * @param {string} headerValue - The x-payment header value.
 * @param {object} paymentRequirements - The payment requirements object.
 * @returns {string} The transaction signature if successful.
 * @throws {Error} If verification or settlement fails.
 */
async function verifyAndSettle(headerValue, paymentRequirements) {
  console.log("[DEBUG] Starting verifyAndSettle");

  // Decode the base64-encoded payment header
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
  } catch (err) {
    return { success: false, error: "Failed to decode x-payment header" };
  }

  // Validate payment requirements match the decoded header
  const innerReq = paymentRequirements.accepts[0];
  if (
    decoded.x402Version !== paymentRequirements.x402Version ||
    decoded.scheme !== innerReq.scheme ||
    decoded.network !== innerReq.network
  ) {
    return {
      success: false,
      error: "Unsupported x402 version / scheme / network",
    };
  }
  const req = innerReq;

  // Extract transaction and reference from payload
  const { txBase64, reference } = decoded.payload ?? {};
  if (!txBase64)
    return { success: false, error: "Missing txBase64 in payload" };
  if (!reference)
    return { success: false, error: "Missing reference in payload" };

  // Deserialize the transaction
  const txBuffer = Buffer.from(txBase64, "base64");
  const tx = solTransaction.from(txBuffer);

  // Get the fee payer from the transaction
  const feePayer = tx.feePayer;
  console.log("feePayer", feePayer.toBase58());

  // Establish Solana connection
  const rpcUrl = functions.config().solana.rpcurl;
  const connection = new Connection(rpcUrl);

  // Check if fee payer is a member (for free access)
  const isMember = await checkMembership(connection, feePayer);
  if (isMember) {
    console.log(`member balance greater than req, granting free access`);
    return { 
      success: true, 
      isMemberAccess: true,
      feePayer: feePayer.toBase58(),
      txHash: null,
      networkId: null,
      error: null,
      message: "Member free access granted"
    };
  } else {
    console.log(
      `non-member balance less than req, proceeding with payment verification`,
    );
  }

  // Verify transaction details
  try {
    verifyTransaction(tx, req);
  } catch (e) {
    return { 
      success: false, 
      txHash: null,
      networkId: null,
      error: e.message 
    };
  }

  // Broadcast the transaction to the network
  console.log("[DEBUG] Broadcasting transaction");
  try {
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
    });
    console.log("[DEBUG] Transaction broadcasted:", sig);
    return { 
      success: true, 
      txHash: sig,
      networkId: "solana-mainnet-beta",
      error: null 
    };
  } catch (e) {
    return { 
      success: false, 
      txHash: null,
      networkId: null,
      error: e.message 
    };
  }
}

// x402 weather sample
/**
 * Firebase Cloud Function for the /weather endpoint.
 * Handles x402 payment verification and returns weather data if payment is valid.
 * Supports membership discounts based on SPL token balance.
 */
exports.weather = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    // Set CORS headers
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type, x-payment");
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    // Validate request method and path
    if (req.method !== "GET" || (req.path !== "/" && req.path !== "/weather")) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Define payment price (0.01 USDC in smallest units)
    const PRICE = 10_000; // 0.01 USDC
    // USDC mint address on Solana mainnet
    const USDC_MINT = new PublicKey(
      `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, // USDC mainnet mint
    );

    // Merchant's token account from config
    const merchantTokenAcc = functions.config().solana.merchanttokenacc;
    const MERCHANT_TOKEN_ACCOUNT = new PublicKey(
      `${merchantTokenAcc}`, // example merchant token account
    );

    // Define payment requirements (TODO: move to database)
    const paymentRequirements = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: `solana-mainnet-beta`,
          asset: USDC_MINT.toBase58(),
          maxAmountRequired: PRICE.toString(),
          payTo: MERCHANT_TOKEN_ACCOUNT.toBase58(),
          resource: "GET /weather",
          description: "Weather API per call (0.01 USDC). Member free access available.",
          mimeType: "application/json",
          outputSchema: {
            type: "object",
            properties: {
              temperatureF: { type: "number" }
            }
          },
          maxTimeoutSeconds: 120,
          extra: {
            memberType: "free access",
            memberSPLToken: functions.config().solana.memberspl,
            memberRequirement: functions.config().solana.membersplreq,
          }
        },
      ],
    };

    // Check for payment header
    const payHeader = req.header("x-payment");
    if (!payHeader) {
      return res.status(402).json(paymentRequirements);
    }
    // Verify and settle the payment
    const result = await verifyAndSettle(payHeader, paymentRequirements);
    if (!result.success) {
      return res.status(402).json({
        ...paymentRequirements,
        error: result.error,
      });
    }

    // Handle member free access
    if (result.isMemberAccess) {
      console.log("[DEBUG] Member free access granted:", result.feePayer);
      // Create member access receipt
      const receipt = {
        memberAccess: true,
        feePayer: result.feePayer,
        message: result.message,
        accessedAt: new Date().toISOString(),
      };
      // Set response header with base64-encoded receipt
      res.set(
        "X-PAYMENT-RESPONSE",
        Buffer.from(JSON.stringify(receipt)).toString("base64"),
      );
      // Return weather data
      return res.json({ temperatureF: 72 });
    }

    // Handle regular payment settlement
    const txHash = result.txHash;
    console.log("[DEBUG] Payment settled:", txHash);
    if (txHash) {
      // Create payment receipt
      const receipt = {
        txHash,
        networkId: result.networkId,
        settledAt: new Date().toISOString(),
      };
      // Set response header with base64-encoded receipt
      res.set(
        "X-PAYMENT-RESPONSE",
        Buffer.from(JSON.stringify(receipt)).toString("base64"),
      );
      // Return weather data
      return res.json({ temperatureF: 72 });
    }
    return res.status(500).json({ error: "Settlement failed" });
  });
});
