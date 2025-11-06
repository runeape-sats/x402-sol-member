# x402-sol-member

A minimal x402 facilitator for detecting membership based on SPL token balance. This project enables pay-per-call API access with Solana-based payments, including membership discounts for token holders.

## Features

- **x402 Payment Integration**: Supports x402 protocol for micro-payments on Solana.
- **Membership Detection**: Checks SPL token balance for membership status and applies discounts.
- **Firebase Backend**: Cloud Functions for payment verification and settlement.
- **React Frontend**: Simple UI for connecting Phantom wallet and making payments.
- **Minimal Dependencies**: Lightweight implementation focused on core functionality.

## Architecture

- **Backend (`functions/`)**: Firebase Cloud Functions handle x402 payment verification, transaction validation, and membership checks.
- **Frontend (`host/`)**: React app built with Vite for user interaction with Phantom wallet.
- **Deployment**: Hosted on Firebase (functions and static hosting).

## Prerequisites

- Node.js (v18 or later)
- Firebase CLI
- Phantom wallet (for testing frontend)
- Solana CLI (optional, for advanced testing)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/runeape-sats/x402-sol-member.git
   cd x402-sol-member
   ```

2. Install dependencies for backend:
   ```bash
   cd functions
   npm install
   cd ..
   ```

3. Install dependencies for frontend:
   ```bash
   cd host
   npm install
   cd ..
   ```

4. Set up Firebase project:
   - Create a Firebase project at [Firebase Console](https://console.firebase.google.com/).
   - Enable Firestore and Functions.
   - Install Firebase CLI: `npm install -g firebase-tools`
   - Login: `firebase login`
   - Initialize: `firebase init` (select Functions and Hosting)

## Configuration

### Environment Variables

Create `.env` files or set in Firebase config:

#### Backend (Firebase Functions Config)
Set these in Firebase Functions config:
```bash
firebase functions:config:set solana.rpcurl="https://api.mainnet-beta.solana.com"
firebase functions:config:set solana.memberspl="YOUR_SPL_TOKEN_MINT_ADDRESS"
firebase functions:config:set solana.membersplreq="MINIMUM_BALANCE_FOR_MEMBERSHIP"
firebase functions:config:set solana.merchanttokenacc="MERCHANT_USDC_TOKEN_ACCOUNT"
```

#### Frontend (Vite Environment)
Create `host/.env`:
```env
VITE_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
VITE_MERCHANT_TOKEN_ACCOUNT=YOUR_MERCHANT_USDC_TOKEN_ACCOUNT
VITE_FIREBASE_FUNCTIONS_URL=https://your-project.firebaseapp.com
```

### Constants
- **USDC Mint**: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (mainnet)
- **Price**: 10,000 (0.01 USDC per call)
- **Membership Token**: Configure your SPL token mint for membership checks.

## Usage

### Development

1. Start Firebase emulators:
   ```bash
   firebase emulators:start
   ```

2. Run frontend in development mode:
   ```bash
   cd host
   npm run dev
   ```

3. Open browser to `http://localhost:5173` (or Vite's default port).

### Testing Payment Flow

1. Connect Phantom wallet.
2. Click "Pay & Fetch /weather" to make a payment and retrieve data.
3. Membership holders (based on SPL balance) skip fee verification.

### API Endpoints

- **GET /weather**: Requires x402 payment header. Returns weather data if payment is valid.

## Deployment

1. Build frontend:
   ```bash
   cd host
   npm run build
   ```

2. Deploy to Firebase:
   ```bash
   firebase deploy
   ```

3. Access at your Firebase hosting URL.

## Contributing

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make changes and test locally.
4. Submit a pull request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This is a proof-of-concept implementation. Use at your own risk. Ensure compliance with Solana and payment regulations.
