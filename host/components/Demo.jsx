import { useState } from "react";
import {
  TransactionInstruction,
  PublicKey,
  Transaction,
  Connection,
} from "@solana/web3.js";
import { ComputeBudgetProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
} from "@solana/spl-token";

/**
 * React component demonstrating the full x402 payment flow.
 * Shows clear state transitions for each step of the payment process.
 */
const Wallet = () => {
  // Wallet state
  const [provider, setProvider] = useState(null);
  const [connection, setConnection] = useState(null);
  
  // x402 flow state
  const [currentStep, setCurrentStep] = useState("idle"); // idle, fetching-requirements, checking-membership, building-tx, signing, submitting, complete
  const [paymentRequirements, setPaymentRequirements] = useState(null);
  const [membershipStatus, setMembershipStatus] = useState(null);
  const [signedTransaction, setSignedTransaction] = useState(null);
  const [paymentReference, setPaymentReference] = useState(null);
  const [weatherData, setWeatherData] = useState(null);
  const [statusMessage, setStatusMessage] = useState("Connect your wallet to start");
  const [errorMessage, setErrorMessage] = useState("");
  const [usdcBalance, setUsdcBalance] = useState(0);
  const [canProceedToPayment, setCanProceedToPayment] = useState(false);

  // Configuration from environment variables (Vite uses import.meta.env)
  const RPC =
    import.meta.env.VITE_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
  const API_URL = import.meta.env.VITE_FIREBASE_FUNCTIONS_URL || "http://127.0.0.1:5001/weather";

  /**
   * Helper function to determine status message color based on content
   */
  const getStatusMessageColor = (message) => {
    if (message.startsWith("✅")) return "#4caf50"; // Green for success
    if (message.startsWith("❌")) return "#f44336"; // Red for errors
    if (message.startsWith("⚠️")) return "#ffeb3b"; // Yellow for warnings
    if (message.includes("Failed") || message.includes("failed")) return "#f44336"; // Red for failed states
    return "#333333"; // Default dark gray for neutral/in-progress
  };

  /**
   * Step 1: Connect to Phantom wallet
   */
  const connectPhantom = async () => {
    setErrorMessage("");
    const provider = window.solana;
    if (!provider?.isPhantom) {
      setErrorMessage("Please install Phantom wallet");
      return;
    }
    try {
      setStatusMessage("Connecting to Phantom wallet...");
      await provider.connect();
      const connection = new Connection(RPC, "confirmed");
      setProvider(provider);
      setConnection(connection);
      setStatusMessage(`✅ Connected: ${provider.publicKey.toBase58().slice(0, 8)}...`);
      setCurrentStep("idle");
    } catch (error) {
      setErrorMessage(`Connection failed: ${error.message}`);
      setStatusMessage("Failed to connect");
    }
  };

  /**
   * Step 2: Fetch payment requirements from x402 endpoint (402 response)
   */
  const fetchPaymentRequirements = async () => {
    setErrorMessage("");
    setCurrentStep("fetching-requirements");
    setStatusMessage("� Fetching payment requirements from /weather endpoint...");
    
    try {
      // Call the endpoint WITHOUT x-payment header to get 402 response
      const response = await fetch(API_URL, {
        method: "GET",
      });

      if (response.status === 402) {
        const requirements = await response.json();
        setPaymentRequirements(requirements);
        setStatusMessage("✅ Received payment requirements (402 Payment Required)");
        setCurrentStep("requirements-received");
        return requirements;
      } else {
        throw new Error(`Expected 402, got ${response.status}`);
      }
    } catch (error) {
      setErrorMessage(`Failed to fetch requirements: ${error.message}`);
      setStatusMessage("❌ Failed to get payment requirements");
      setCurrentStep("idle");
      throw error;
    }
  };

  /**
   * Step 3: Check membership status
   */
  const checkMembership = async () => {
    if (!paymentRequirements) {
      setErrorMessage("Please fetch payment requirements first");
      return;
    }

    setErrorMessage("");
    setCurrentStep("checking-membership");
    setStatusMessage("🔍 Checking membership status...");
    
    try {
      const memberInfo = paymentRequirements.accepts[0].extra;
      const memberSPLToken = memberInfo?.memberSPLToken;
      const memberRequirement = Number(memberInfo?.memberRequirement || 0);

      if (!memberSPLToken) {
        setMembershipStatus({
          isMember: false,
          balance: 0,
          required: 0,
          message: "No membership program available"
        });
        setStatusMessage("ℹ️ No membership program configured");
        setCurrentStep("membership-checked");
        return;
      }

      // Check user's token balance
      const { TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
        provider.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      const memberTokenAccount = tokenAccounts.value.find(
        (account) => account.account.data.parsed.info.mint === memberSPLToken
      );

      const balance = memberTokenAccount 
        ? Number(memberTokenAccount.account.data.parsed.info.tokenAmount.uiAmount)
        : 0;

      const isMember = balance > memberRequirement;

      setMembershipStatus({
        isMember,
        balance,
        required: memberRequirement,
        tokenAddress: memberSPLToken,
        message: isMember 
          ? "✅ Member status: Eligible for free access!"
          : `❌ Not a member: ${balance} tokens (need > ${memberRequirement})`
      });

      setStatusMessage(
        isMember 
          ? `✅ Member detected! (${balance} tokens) - Transaction will be built but server may grant free access`
          : `Not a member. Balance: ${balance}, Required: > ${memberRequirement} - Payment required`
      );
      setCurrentStep("membership-checked");
      
      // Check USDC balance
      const usdcMint = paymentRequirements.accepts[0].asset;
      const usdcTokenAccount = tokenAccounts.value.find(
        (account) => account.account.data.parsed.info.mint === usdcMint
      );
      const usdcBal = usdcTokenAccount 
        ? Number(usdcTokenAccount.account.data.parsed.info.tokenAmount.uiAmount)
        : 0;
      setUsdcBalance(usdcBal);
      
      // Check if sufficient for payment
      const PRICE = Number(paymentRequirements.accepts[0].maxAmountRequired);
      const sufficient = usdcBal * 1_000_000 >= PRICE;
      setCanProceedToPayment(sufficient);
      
    } catch (error) {
      setErrorMessage(`Failed to check membership: ${error.message}`);
      setStatusMessage("❌ Membership check failed");
      setCurrentStep("requirements-received");
      throw error;
    }
  };

  /**
   * Step 4: Build payment transaction based on requirements
   */
  const buildPaymentTransaction = async (requirements) => {
    setCurrentStep("building-tx");
    
    const memberNote = membershipStatus?.isMember 
      ? " (Member - server may grant free access)" 
      : " (Non-member - payment required)";
    setStatusMessage("🔨 Building payment transaction..." + memberNote);
    
    try {
      const paymentSpec = requirements.accepts[0];
      const PRICE = Number(paymentSpec.maxAmountRequired);
      
      // Check if USDC balance is sufficient
      if (usdcBalance * 1_000_000 < PRICE) {
        throw new Error(`Insufficient USDC balance: ${usdcBalance} USDC, required: ${PRICE / 1_000_000} USDC`);
      }
      
      const USDC_MINT = new PublicKey(paymentSpec.asset);

      // Get the buyer's associated token account for USDC
      const buyerATA = await getAssociatedTokenAddress(
        USDC_MINT,
        provider.publicKey,
      );

      // Create a new transaction with recent blockhash
      const { blockhash } = await connection.getLatestBlockhash();
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: provider.publicKey,
      });

      // Add USDC transfer instruction
      tx.add(
        createTransferCheckedInstruction(
          buyerATA,
          USDC_MINT,
          MERCHANT_TOKEN_ACCOUNT,
          provider.publicKey,
          PRICE,
          6, // USDC has 6 decimals
        ),
      );

      // Generate a unique reference for the payment
      const ref = crypto.randomUUID();
      setPaymentReference(ref);
      
      // Add memo instruction with x402 reference
      tx.add(
        new TransactionInstruction({
          keys: [],
          programId: new PublicKey(
            "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Solana memo program
          ),
          data: new TextEncoder().encode(`x402:${ref}`),
        }),
      );

      // Add compute budget instructions for efficient execution
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 130_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
      );

      const memberStatusMsg = membershipStatus?.isMember 
        ? " - Member: Server will decide to broadcast or bypass"
        : "";
      setStatusMessage(`✅ Transaction built (${PRICE / 1_000_000} USDC)${memberStatusMsg}`);
      setCurrentStep("tx-built");
      return { tx, ref, price: PRICE };
    } catch (error) {
      setErrorMessage(`Failed to build transaction: ${error.message}`);
      setStatusMessage("❌ Transaction build failed");
      setCurrentStep("membership-checked");
      throw error;
    }
  };

  /**
   * Step 5: Sign transaction with Phantom
   */
  const signTransaction = async (tx) => {
    setCurrentStep("signing");
    setStatusMessage("✍️ Requesting signature from Phantom wallet...");
    
    try {
      const signed = await provider.signTransaction(tx);
      setSignedTransaction(signed);
      setStatusMessage("✅ Transaction signed by wallet");
      setCurrentStep("tx-signed");
      return signed;
    } catch (error) {
      setErrorMessage(`Signing failed: ${error.message}`);
      setStatusMessage("❌ User rejected or signing failed");
      setCurrentStep("tx-built");
      throw error;
    }
  };

  /**
   * Step 6: Submit payment to x402 endpoint
   */
  const submitPayment = async (signed, ref, requirements) => {
    setCurrentStep("submitting");
    setStatusMessage("📤 Submitting payment to /weather endpoint...");
    
    try {
      // Build x402 payment header
      const uint8ArrayToBase64 = (uint8Array) => {
        let binary = '';
        uint8Array.forEach(byte => binary += String.fromCharCode(byte));
        return btoa(binary);
      };
      
      const txBase64 = uint8ArrayToBase64(signed.serialize());
      const paymentSpec = requirements.accepts[0];
      
      const xPayment = btoa(
        JSON.stringify({
          x402Version: requirements.x402Version,
          scheme: paymentSpec.scheme,
          network: paymentSpec.network,
          payload: { txBase64, reference: ref },
        })
      );

      // Call API with x-payment header
      const response = await fetch(API_URL, {
        method: "GET",
        headers: { "X-PAYMENT": xPayment },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `API error: ${response.status}`);
      }

      const data = await response.json();
      
      // Check for payment response header
      const paymentResponse = response.headers.get("X-PAYMENT-RESPONSE");
      let receipt = null;
      if (paymentResponse) {
        receipt = JSON.parse(atob(paymentResponse));
      }

      setWeatherData(data);
      setStatusMessage(
        receipt?.txHash 
          ? `✅ Payment settled! Transaction: ${receipt?.txHash?.slice(0, 8)}...`
          : "✅ Member access granted. No payment required. Tx not broadcasted"
      );
      setCurrentStep("complete");
      
      return { data, receipt };
    } catch (error) {
      setErrorMessage(`Payment submission failed: ${error.message}`);
      setStatusMessage("❌ Payment failed");
      setCurrentStep("tx-signed");
      throw error;
    }
  };

  /**
   * Combined Step 4-6: Process payment (build, sign, submit)
   */
  const processPayment = async (requirements) => {
    setErrorMessage("");
    setCurrentStep("building-tx");
    
    const memberNote = membershipStatus?.isMember 
      ? " (Member - server may grant free access)" 
      : " (Non-member - payment required)";
    setStatusMessage("🔨 Building payment transaction..." + memberNote);
    
    try {
      // Build transaction
      const paymentSpec = requirements.accepts[0];
      const USDC_MINT = new PublicKey(paymentSpec.asset);
      const MERCHANT_TOKEN_ACCOUNT = new PublicKey(paymentSpec.payTo);
      const PRICE = Number(paymentSpec.maxAmountRequired);

      // Get the buyer's associated token account for USDC
      const buyerATA = await getAssociatedTokenAddress(
        USDC_MINT,
        provider.publicKey,
      );

      // Create a new transaction with recent blockhash
      const { blockhash } = await connection.getLatestBlockhash();
      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: provider.publicKey,
      });

      // Add USDC transfer instruction
      tx.add(
        createTransferCheckedInstruction(
          buyerATA,
          USDC_MINT,
          MERCHANT_TOKEN_ACCOUNT,
          provider.publicKey,
          PRICE,
          6, // USDC has 6 decimals
        ),
      );

      // Generate a unique reference for the payment
      const ref = crypto.randomUUID();
      setPaymentReference(ref);
      
      // Add memo instruction with x402 reference
      tx.add(
        new TransactionInstruction({
          keys: [],
          programId: new PublicKey(
            "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", // Solana memo program
          ),
          data: new TextEncoder().encode(`x402:${ref}`),
        }),
      );

      // Add compute budget instructions for efficient execution
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 130_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
      );

      const memberStatusMsg = membershipStatus?.isMember 
        ? " - Member: Server will decide to broadcast or bypass"
        : "";
      setStatusMessage(`✅ Transaction built (${PRICE / 1_000_000} USDC)${memberStatusMsg}`);
      setCurrentStep("tx-built");

      // Sign transaction
      setCurrentStep("signing");
      setStatusMessage("✍️ Requesting signature from Phantom wallet...");
      
      const signed = await provider.signTransaction(tx);
      setSignedTransaction(signed);
      setStatusMessage("✅ Transaction signed by wallet");
      setCurrentStep("tx-signed");

      // Submit payment
      setCurrentStep("submitting");
      setStatusMessage("📤 Submitting payment to /weather endpoint...");
      
      // Build x402 payment header
      const uint8ArrayToBase64 = (uint8Array) => {
        let binary = '';
        uint8Array.forEach(byte => binary += String.fromCharCode(byte));
        return btoa(binary);
      };
      
      const txBase64 = uint8ArrayToBase64(signed.serialize());
      
      const xPayment = btoa(
        JSON.stringify({
          x402Version: requirements.x402Version,
          scheme: paymentSpec.scheme,
          network: paymentSpec.network,
          payload: { txBase64, reference: ref },
        })
      );

      // Call API with x-payment header
      const response = await fetch(API_URL, {
        method: "GET",
        headers: { "X-PAYMENT": xPayment },
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `API error: ${response.status}`);
      }

      const data = await response.json();
      
      // Check for payment response header
      const paymentResponse = response.headers.get("X-PAYMENT-RESPONSE");
      let receipt = null;
      if (paymentResponse) {
        receipt = JSON.parse(atob(paymentResponse));
      }

      setWeatherData(data);
      setStatusMessage(
        receipt?.txHash 
          ? `✅ Payment settled! Transaction: ${receipt?.txHash?.slice(0, 8)}...`
          : "✅ Member access granted. No payment required. Tx not broadcasted"
      );
      setCurrentStep("complete");
      
      return { data, receipt };
    } catch (error) {
      setErrorMessage(`Payment processing failed: ${error.message}`);
      setStatusMessage("❌ Payment failed");
      setCurrentStep("membership-checked");
      throw error;
    }
  };

  /**
   * Full flow: Execute all steps in sequence
   */
  const executeFullFlow = async () => {
    if (!provider || !connection) {
      setErrorMessage("Please connect wallet first");
      return;
    }

    try {
      // Reset state
      setWeatherData(null);
      setErrorMessage("");
      
      // Step 2: Fetch requirements
      const requirements = await fetchPaymentRequirements();
      
      // Step 3: Check membership
      await checkMembership();
      
      // Step 4: Process payment (build, sign, submit)
      await processPayment(requirements);
      
    } catch (error) {
      console.error("Flow error:", error);
    }
  };

  /**
   * Reset the demo to start over
   */
  const resetDemo = () => {
    setCurrentStep("idle");
    setPaymentRequirements(null);
    setMembershipStatus(null);
    setSignedTransaction(null);
    setPaymentReference(null);
    setWeatherData(null);
    setErrorMessage("");
    setStatusMessage(provider ? "Ready to start new payment flow" : "Connect your wallet to start");
  };

  return (
    <div style={{ 
      maxWidth: "1000px", 
      margin: "0 auto", 
      padding: "40px 20px", 
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      backgroundColor: "#ffffff",
      color: "#000000",
      minHeight: "100vh"
    }}>
      <h1 style={{ 
        fontSize: "32px", 
        fontWeight: "300", 
        marginBottom: "8px",
        letterSpacing: "-0.5px" 
      }}>
        x402 Payment Protocol
      </h1>
      <p style={{ 
        color: "#666", 
        fontSize: "14px", 
        fontWeight: "300",
        marginBottom: "40px" 
      }}>
        Solana Weather API · Step-by-step payment flow demonstration
      </p>

      {/* Step 1: Wallet Connection */}
      <div style={{ 
        marginBottom: "24px", 
        padding: "24px", 
        border: "1px solid #e0e0e0",
        backgroundColor: "#fafafa"
      }}>
        <h2 style={{ 
          fontSize: "14px", 
          fontWeight: "500", 
          marginBottom: "12px",
          textTransform: "uppercase",
          letterSpacing: "0.5px"
        }}>
          Step 1 · Wallet Connection
        </h2>
        <button 
          onClick={connectPhantom} 
          disabled={provider !== null}
          style={{
            padding: "12px 24px",
            fontSize: "13px",
            cursor: provider ? "not-allowed" : "pointer",
            backgroundColor: provider ? "#f5f5f5" : "#000000",
            color: provider ? "#999" : "#ffffff",
            border: "1px solid #000000",
            fontWeight: "400",
            letterSpacing: "0.3px",
            transition: "all 0.2s"
          }}
        >
          {provider ? `Connected ${provider.publicKey.toBase58().slice(0, 8)}...` : "Connect Phantom Wallet"}
        </button>
      </div>

      {/* Step 2: Fetch Payment Requirements */}
      {provider && (
        <div style={{ 
          marginBottom: "24px", 
          padding: "24px", 
          border: "1px solid #e0e0e0",
          backgroundColor: "#fafafa"
        }}>
          <h2 style={{ 
            fontSize: "14px", 
            fontWeight: "500", 
            marginBottom: "12px",
            textTransform: "uppercase",
            letterSpacing: "0.5px"
          }}>
            Step 2 · Payment Requirements
          </h2>
          <p style={{ fontSize: "12px", color: "#666", marginBottom: "12px", lineHeight: "1.5" }}>
            Retrieve 402 Payment Required response from endpoint
          </p>
          <button 
            onClick={fetchPaymentRequirements}
            disabled={currentStep !== "idle" && currentStep !== "requirements-received"}
            style={{
              padding: "12px 24px",
              fontSize: "13px",
              cursor: (currentStep === "idle" || currentStep === "requirements-received") ? "pointer" : "not-allowed",
              backgroundColor: (currentStep === "idle" || currentStep === "requirements-received") ? "#000000" : "#f5f5f5",
              color: (currentStep === "idle" || currentStep === "requirements-received") ? "#ffffff" : "#999",
              border: "1px solid #000000",
              fontWeight: "400",
              letterSpacing: "0.3px"
            }}
          >
            Fetch Requirements
          </button>
          {paymentRequirements && (
            <div style={{ 
              marginTop: "16px", 
              padding: "16px", 
              backgroundColor: "#ffffff", 
              border: "1px solid #e0e0e0",
              fontSize: "11px"
            }}>
              <pre style={{ 
                overflow: "auto", 
                margin: 0, 
                fontFamily: "monospace",
                lineHeight: "1.5",
                color: "#333"
              }}>
                {JSON.stringify(paymentRequirements, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Step 3: Check Membership */}
      {paymentRequirements && (
        <div style={{ 
          marginBottom: "24px", 
          padding: "24px", 
          border: "1px solid #e0e0e0",
          backgroundColor: membershipStatus?.isMember ? "#f0f9ff" : "#fafafa"
        }}>
          <h2 style={{ 
            fontSize: "14px", 
            fontWeight: "500", 
            marginBottom: "12px",
            textTransform: "uppercase",
            letterSpacing: "0.5px"
          }}>
            Step 3 · Balance & Membership Check
          </h2>
          <p style={{ fontSize: "12px", color: "#666", marginBottom: "12px", lineHeight: "1.5" }}>
            Check if wallet holds required SPL tokens for payment or membership benefits
          </p>
          <button 
            onClick={checkMembership}
            disabled={currentStep !== "requirements-received" && currentStep !== "membership-checked"}
            style={{
              padding: "12px 24px",
              fontSize: "13px",
              cursor: (currentStep === "requirements-received" || currentStep === "membership-checked") ? "pointer" : "not-allowed",
              backgroundColor: (currentStep === "requirements-received" || currentStep === "membership-checked") ? "#000000" : "#f5f5f5",
              color: (currentStep === "requirements-received" || currentStep === "membership-checked") ? "#ffffff" : "#999",
              border: "1px solid #000000",
              fontWeight: "400",
              letterSpacing: "0.3px"
            }}
          >
            Check
          </button>
          {membershipStatus && (
            <div style={{ 
              marginTop: "16px", 
              padding: "16px", 
              backgroundColor: "#ffffff", 
              border: "1px solid #e0e0e0",
              fontSize: "13px",
              lineHeight: "1.6"
            }}>
              <div style={{ fontWeight: "500", marginBottom: "8px" }}>
                {membershipStatus.message}
              </div>
              <div style={{ color: "#666", fontSize: "12px", fontFamily: "monospace" }}>
                USDC Balance: {usdcBalance} USDC
                <br />
                SPL Token: <a href={`https://solscan.io/token/${membershipStatus.tokenAddress}`} target="_blank" rel="noopener noreferrer">{membershipStatus.tokenAddress?.slice(0, 12)}...</a>
                <br />
                Balance: {membershipStatus.balance} tokens
                <br />
                Required: {'>='} {membershipStatus.required} tokens
                <br />
                {!canProceedToPayment && (
                  <span style={{ color: "#d32f2f", fontWeight: "500" }}>
                    ⚠️ Warning: USDC balance insufficient for verification. Step 4 disabled.
                  </span>
                )}
                <br />
                {membershipStatus.isMember && (
                  <span style={{ color: "#000", fontWeight: "500" }}>
                    Note: <b>Transaction will be built for verification. Upon successful verification, x402 facilitator will grant free access and skip broadcasting payment.</b>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 4: Process Payment */}
      {membershipStatus && (
        <div style={{ 
          marginBottom: "24px", 
          padding: "24px", 
          border: "1px solid #e0e0e0",
          backgroundColor: "#fafafa"
        }}>
          <h2 style={{ 
            fontSize: "14px", 
            fontWeight: "500", 
            marginBottom: "12px",
            textTransform: "uppercase",
            letterSpacing: "0.5px"
          }}>
            Step 4 · Process Payment
          </h2>
          <p style={{ fontSize: "12px", color: "#666", marginBottom: "12px", lineHeight: "1.5" }}>
            Build, sign, and submit transaction. For members, server verifies membership and may bypass payment.
          </p>
          <button 
            onClick={async () => {
              try {
                await processPayment(paymentRequirements);
              } catch (e) {
                console.error(e);
              }
            }}
            disabled={currentStep !== "membership-checked" || !canProceedToPayment}
            style={{
              padding: "12px 24px",
              fontSize: "13px",
              cursor: (currentStep === "membership-checked" && canProceedToPayment) ? "pointer" : "not-allowed",
              backgroundColor: (currentStep === "membership-checked" && canProceedToPayment) ? "#000000" : "#f5f5f5",
              color: (currentStep === "membership-checked" && canProceedToPayment) ? "#ffffff" : "#999",
              border: "1px solid #000000",
              fontWeight: "400",
              letterSpacing: "0.3px"
            }}
          >
            Process Payment
          </button>
          {currentStep === "tx-built" && paymentReference && (
            <div style={{ 
              marginTop: "16px", 
              padding: "16px", 
              backgroundColor: "#ffffff",
              border: "1px solid #e0e0e0",
              fontSize: "12px",
              lineHeight: "1.6"
            }}>
              <div style={{ fontFamily: "monospace", color: "#333" }}>
                Amount: {paymentRequirements.accepts[0].maxAmountRequired / 1_000_000} USDC
                <br />
                Reference: {paymentReference}
                <br />
                Merchant: {paymentRequirements.accepts[0].payTo.slice(0, 16)}...
                {membershipStatus?.isMember && (
                  <>
                    <br />
                    <span style={{ color: "#000", fontWeight: "500" }}>
                      Member Status: Server will verify and may bypass payment
                    </span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      

      {/* Weather Result */}
      {weatherData && (
        <div style={{ 
          marginBottom: "24px", 
          padding: "32px", 
          border: "2px solid #3c9e24ff",
          backgroundColor: "#f0f9ff",
          textAlign: "center"
        }}>
          <h2 style={{ 
            fontSize: "14px", 
            fontWeight: "500", 
            marginBottom: "16px",
            textTransform: "uppercase",
            letterSpacing: "0.5px",
            color: "#3c9e24ff"
          }}>
            x402 Access Granted
          </h2>
          <div style={{ fontSize: "48px", fontWeight: "200", margin: "16px 0" }}>
            {weatherData.temperatureF}°F
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div style={{ 
        marginTop: "32px", 
        padding: "24px", 
        backgroundColor: "#fafafa",
        border: "1px solid #e0e0e0"
      }}>
        <h3 style={{ 
          fontSize: "14px", 
          fontWeight: "500", 
          marginBottom: "16px",
          textTransform: "uppercase",
          letterSpacing: "0.5px"
        }}>
          Quick Actions
        </h3>
        <button 
          onClick={executeFullFlow}
          disabled={!provider || (currentStep !== "idle" && currentStep !== "complete")}
          style={{
            padding: "12px 24px",
            fontSize: "13px",
            marginRight: "12px",
            cursor: (provider && (currentStep === "idle" || currentStep === "complete")) ? "pointer" : "not-allowed",
            backgroundColor: (provider && (currentStep === "idle" || currentStep === "complete")) ? "#000000" : "#f5f5f5",
            color: (provider && (currentStep === "idle" || currentStep === "complete")) ? "#ffffff" : "#999",
            border: "1px solid #000000",
            fontWeight: "400",
            letterSpacing: "0.3px"
          }}
        >
          Execute Full Flow
        </button>
        <button 
          onClick={resetDemo}
          disabled={currentStep === "idle" && !weatherData}
          style={{
            padding: "12px 24px",
            fontSize: "13px",
            cursor: (currentStep !== "idle" || weatherData) ? "pointer" : "not-allowed",
            backgroundColor: "#ffffff",
            color: (currentStep !== "idle" || weatherData) ? "#000000" : "#999",
            border: "1px solid #000000",
            fontWeight: "400",
            letterSpacing: "0.3px"
          }}
        >
          Reset Demo
        </button>
      </div>
    </div>
  );
};

export default Wallet;
