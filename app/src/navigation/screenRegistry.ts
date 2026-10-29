import type { ComponentType } from 'react';

import { NewAccountConfigureScreen } from '@/screens/accounts/NewAccountConfigureScreen';
import { NewAccountTiersScreen } from '@/screens/accounts/NewAccountTiersScreen';
import { AlertsScreen } from '@/screens/alerts/AlertsScreen';
import { ForgotPasswordScreen } from '@/screens/auth/ForgotPasswordScreen';
import { LoginScreen } from '@/screens/auth/LoginScreen';
import { RegisterScreen } from '@/screens/auth/RegisterScreen';
import { ResetPasswordScreen } from '@/screens/auth/ResetPasswordScreen';
import { VerifyEmailScreen } from '@/screens/auth/VerifyEmailScreen';
import { CmsPageScreen } from '@/screens/cms/CmsPageScreen';
import { CopyTradingScreen } from '@/screens/copy/CopyTradingScreen';
import { TraderDashboardScreen } from '@/screens/copy/TraderDashboardScreen';
import { TradeScreen } from '@/screens/trade/TradeScreen';
import { DashboardScreen } from '@/screens/dashboard/DashboardScreen';
import { ExploreScreen } from '@/screens/explore/ExploreScreen';
import { FeedbackScreen } from '@/screens/feedback/FeedbackScreen';
import { PositionsScreen } from '@/screens/positions/PositionsScreen';
import { MarketListScreen } from '@/screens/markets/MarketListScreen';
import { OptionChainScreen } from '@/screens/markets/OptionChainScreen';
import { StockDetailScreen } from '@/screens/markets/StockDetailScreen';
import { HelpdeskChatScreen } from '@/screens/helpdesk/HelpdeskChatScreen';
import { HelpdeskScreen } from '@/screens/helpdesk/HelpdeskScreen';
import { LandingScreen } from '@/screens/landing/LandingScreen';
import { NewsArticleScreen } from '@/screens/news/NewsArticleScreen';
import { NewsScreen } from '@/screens/news/NewsScreen';
import { OrdersScreen } from '@/screens/orders/OrdersScreen';
import { PartnerScreen } from '@/screens/partner/PartnerScreen';
import { PlansScreen } from '@/screens/plans/PlansScreen';
import { ProfileScreen } from '@/screens/profile/ProfileScreen';
import { ReportsScreen } from '@/screens/reports/ReportsScreen';
import { BonusWalletScreen } from '@/screens/wallet/BonusWalletScreen';
import { WalletScreen } from '@/screens/wallet/WalletScreen';
import { WatchlistScreen } from '@/screens/watchlist/WatchlistScreen';

import type { AppScreenProps, ScreenName } from './types';

/**
 * Route → component. THE place a ported screen is plugged in.
 *
 * To register a screen: import it (named export, from
 * src/screens/<area>/<Name>Screen.tsx) and replace its `ComingSoonScreen`
 * below. Nothing else in navigation/ changes — the navigator, the header,
 * the rail and the deep links all read from here and from types.ts.
 */
export const screenRegistry: { [N in ScreenName]: ComponentType<AppScreenProps<N>> } = {
  // Signed-out
  Landing: LandingScreen,
  Login: LoginScreen,
  Register: RegisterScreen,
  ForgotPassword: ForgotPasswordScreen,

  // Public
  ResetPassword: ResetPasswordScreen,
  VerifyEmail: VerifyEmailScreen,
  CmsPage: CmsPageScreen,
  News: NewsScreen,
  NewsArticle: NewsArticleScreen,

  // Signed-in
  Explore: ExploreScreen,
  Dashboard: DashboardScreen,
  MarketList: MarketListScreen,
  Positions: PositionsScreen,
  Options: OptionChainScreen,
  Watchlist: WatchlistScreen,
  Trade: TradeScreen,
  StockDetail: StockDetailScreen,
  Orders: OrdersScreen,
  Reports: ReportsScreen,
  Alerts: AlertsScreen,
  Partner: PartnerScreen,
  Plans: PlansScreen,
  BonusWallet: BonusWalletScreen,
  CopyTrading: CopyTradingScreen,
  TraderDashboard: TraderDashboardScreen,
  Wallet: WalletScreen,
  NewAccountTiers: NewAccountTiersScreen,
  NewAccountConfigure: NewAccountConfigureScreen,
  Profile: ProfileScreen,
  Helpdesk: HelpdeskScreen,
  HelpdeskChat: HelpdeskChatScreen,
  Feedback: FeedbackScreen,
};
