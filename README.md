# x402-sol-member

You can add SPL token balance check to a x402 facilitator. This is a minimal (no-viem) dependency x402 facilitator (using serverless Firebase Functions) for providing a member-only access based on SPL token balance or processing a x402 payment. This sample project comes with a minimum React client for pay-per-call API access with Solana-based USDC payments.

## Why?
1. You can host your x402 facilitator using serverless Firebase Functions (pay-for-use plan). Your facilitator does not even need to hold any pkeys.
2. You can customize x402 payment requirements including SPL-based membership access in this example.

## Features

- **x402 Payment Integration**: Supports x402 protocol for micro-payments on Solana.
- **Membership Detection**: Checks SPL token balance for membership status and skip payment broadcasting (i.e., free API access for members).
- **Firebase Backend**: Serverless Cloud Functions for payment verification and settlement. Pay-per-use serverless setup instead of dedicated server hosting.
- **React Frontend**: Simple UI for connecting Phantom wallet and making payments.
- **Minimal Dependencies**: Lightweight implementation focused on core functionality. No viem, no typescripts.

## Architecture

- **Backend (`functions/`)**: Firebase Cloud Functions handle x402 payment verification, transaction validation, and membership checks.
- **Frontend (`host/`)**: React app built with Vite for user interaction with Phantom wallet.
- **Deployment**: It's up to you but it's easy to host on Firebase (functions and static hosting).

## Prerequisites

- Node.js (v18 or later)
- Firebase CLI (for setting up a Firebase project)
- Phantom wallet (for web-client payment)
- Solana RPC url
- Solana address for receiving x402 payment

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/runeape-sats/x402-sol-member.git
   cd x402-sol-member
   ```
2. Set up Firebase project:
   - Install Firebase CLI: `npm install -g firebase-tools`
   - Login: `firebase login`
   - Initialize: `firebase init` (select Functions and Hosting)
     
3. Set up facilitator using Firebase Functions:
   ```bash
   cd functions
   npm i
   ```
   Set these in Firebase Functions config:
   ```bash
   firebase functions:config:set solana.rpcurl="https://api.mainnet-beta.solana.com"
   firebase functions:config:set solana.memberspl="YOUR_SPL_TOKEN_MINT_ADDRESS"
   firebase functions:config:set solana.membersplreq="MINIMUM_BALANCE_FOR_MEMBERSHIP"
   firebase functions:config:set solana.merchanttokenacc="MERCHANT_USDC_TOKEN_ACCOUNT"
   ```
   
   Get current env variables - firebase functions:config:get
   [required] after setting env vars, download current env variable so that local emulator can run - `firebase functions:config:get > .runtimeconfig.json`

   Run the local Firebase Fucntions simulator
   `firebase emulators:start --only functions`

   Check endpoint
   - **GET /weather**: Requires x402 payment header. Returns weather data if payment is valid.

5. Set up web client:
   ```bash
   cd host
   npm i
   ```
   
   Create `host/.env`:
   ```env
   VITE_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
   VITE_MERCHANT_TOKEN_ACCOUNT=YOUR_MERCHANT_USDC_TOKEN_ACCOUNT
   VITE_FIREBASE_FUNCTIONS_URL=https://your-project.firebaseapp.com
   ```
   
   Run `npm run dev`
   
   Open browser to `http://localhost:5173` (or Vite's default port).

### Constants
- **USDC Mint**: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (mainnet)
- **Price**: 10,000 ($0.01 USDC per call)
- **Membership Token**: Configure your SPL token mint for membership checks.

### Testing Payment Flow

1. Connect Phantom wallet.
2. Click "Pay & Fetch /weather" to make a payment and retrieve data.
3. Membership holders (based on SPL balance) skip fee verification.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This is a proof-of-concept implementation. Use at your own risk. Ensure compliance with Solana and payment regulations.
