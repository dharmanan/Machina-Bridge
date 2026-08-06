import { useEffect, useMemo, useState } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useAccount, useSwitchChain } from 'wagmi'
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FlaskConical,
  Lock,
  RotateCcw,
  Wallet,
} from 'lucide-react'
import arcLogo from '../assets/arc.png'
import { ARC_EVM_CHAIN_ID } from '../lib/chains'

const TOTAL_D