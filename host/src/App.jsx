import './App.css'
import { Buffer } from 'buffer'

// Make Buffer available globally for Solana libraries
window.Buffer = Buffer
import Wallet from '../components/Wallet'

function App() {
  return (
    <div className="app">
      <Wallet />
    </div>
  )
}

export default App
