import React, { useEffect } from 'react';
import { TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { DrawerActions } from '@react-navigation/native';
import { useAuth } from '../store/auth';
import { useAccounts } from '../store/account';
import { useColors } from '../theme';
import { Loader } from '../components/ui';
import DrawerContent from './DrawerContent';

import LoginScreen from '../screens/LoginScreen';
import HomeScreen from '../screens/HomeScreen';
import MarketsScreen from '../screens/MarketsScreen';
import TradeScreen from '../screens/TradeScreen';
import PortfolioScreen from '../screens/PortfolioScreen';
import ProfileScreen from '../screens/ProfileScreen';
import MoreScreen from '../screens/MoreScreen';
import WalletScreen from '../screens/WalletScreen';
import CopyScreen from '../screens/CopyScreen';
import HistoryScreen from '../screens/HistoryScreen';
import SettingsScreen from '../screens/SettingsScreen';
import ComingSoon from '../screens/ComingSoon';
import InstrumentDetailScreen from '../screens/InstrumentDetailScreen';
import OrderTicketScreen from '../screens/OrderTicketScreen';
import FundScreen from '../screens/FundScreen';
import CopySetupScreen from '../screens/CopySetupScreen';
import TraderProfileScreen from '../screens/TraderProfileScreen';
import KycScreen from '../screens/KycScreen';
import PlansScreen from '../screens/PlansScreen';
import ReportsScreen from '../screens/ReportsScreen';
import WatchlistScreen from '../screens/WatchlistScreen';
import PartnerScreen from '../screens/PartnerScreen';
import AlertsScreen from '../screens/AlertsScreen';
import SupportScreen from '../screens/SupportScreen';
import FeedbackScreen from '../screens/FeedbackScreen';
import NewsScreen from '../screens/NewsScreen';
import NewAccountTiersScreen from '../screens/NewAccountTiersScreen';
import NewAccountConfigureScreen from '../screens/NewAccountConfigureScreen';

const RootStack = createNativeStackNavigator();
const AppStack = createNativeStackNavigator();
const Drawer = createDrawerNavigator();
const Tab = createBottomTabNavigator();

const tabIcon = (name) => ({ color, size, focused }) => (
  <Ionicons name={focused ? name : `${name}-outline`} size={size ?? 22} color={color} />
);

function Hamburger({ navigation, color }) {
  return (
    <TouchableOpacity onPress={() => navigation.dispatch(DrawerActions.openDrawer())} style={{ paddingHorizontal: 14, paddingVertical: 4 }}>
      <Ionicons name="menu" size={24} color={color} />
    </TouchableOpacity>
  );
}

function Tabs() {
  const c = useColors();
  return (
    <Tab.Navigator
      screenOptions={({ navigation }) => ({
        headerStyle: { backgroundColor: c.card },
        headerTitleStyle: { color: c.textPrimary, fontWeight: '800' },
        headerShadowVisible: false,
        headerLeft: () => <Hamburger navigation={navigation} color={c.textSecondary} />,
        tabBarActiveTintColor: c.primary500,
        tabBarInactiveTintColor: c.textMuted,
        tabBarStyle: { backgroundColor: c.card, borderTopColor: c.border },
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarIcon: tabIcon('home'), headerShown: false }} />
      <Tab.Screen name="Markets" component={MarketsScreen} options={{ tabBarIcon: tabIcon('stats-chart') }} />
      <Tab.Screen name="Trade" component={TradeScreen} options={{ tabBarIcon: tabIcon('trending-up') }} />
      <Tab.Screen name="Portfolio" component={PortfolioScreen} options={{ tabBarIcon: tabIcon('pie-chart') }} />
      <Tab.Screen name="Profile" component={ProfileScreen} options={{ tabBarIcon: tabIcon('person') }} />
      <Tab.Screen name="More" component={MoreScreen} options={{ tabBarIcon: tabIcon('ellipsis-horizontal') }} />
    </Tab.Navigator>
  );
}

function DrawerNav() {
  return (
    <Drawer.Navigator
      drawerContent={(props) => <DrawerContent {...props} />}
      screenOptions={{ headerShown: false, drawerType: 'front' }}
    >
      <Drawer.Screen name="Tabs" component={Tabs} />
    </Drawer.Navigator>
  );
}

function AuthedApp() {
  const c = useColors();
  const loadAccounts = useAccounts((s) => s.load);
  useEffect(() => { loadAccounts(); }, [loadAccounts]);
  const opts = {
    headerStyle: { backgroundColor: c.card },
    headerTitleStyle: { color: c.textPrimary, fontWeight: '800' },
    headerTintColor: c.primary500,
    headerShadowVisible: false,
    contentStyle: { backgroundColor: c.bg },
  };
  const soon = (icon, title, message) => ({ initialParams: { icon, title, message }, options: { title } });
  return (
    <AppStack.Navigator screenOptions={opts}>
      <AppStack.Screen name="DrawerRoot" component={DrawerNav} options={{ headerShown: false }} />
      {/* Detail / modal screens */}
      <AppStack.Screen name="InstrumentDetail" component={InstrumentDetailScreen} options={{ title: '' }} />
      <AppStack.Screen name="OrderTicket" component={OrderTicketScreen} options={{ title: 'Order ticket' }} />
      <AppStack.Screen name="Fund" component={FundScreen} options={{ title: 'Deposit / Withdraw' }} />
      <AppStack.Screen name="CopySetup" component={CopySetupScreen} options={{ title: 'Copy trader' }} />
      <AppStack.Screen name="TraderProfile" component={TraderProfileScreen} options={{ title: 'Trader' }} />
      {/* Drawer / More destinations (stack screens → keep a back button) */}
      <AppStack.Screen name="Wallet" component={WalletScreen} options={{ title: 'Wallet' }} />
      <AppStack.Screen name="Copy" component={CopyScreen} options={{ title: 'Copy Trading' }} />
      <AppStack.Screen name="History" component={HistoryScreen} options={{ title: 'History' }} />
      <AppStack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
      <AppStack.Screen name="Kyc" component={KycScreen} options={{ title: 'KYC verification' }} />
      <AppStack.Screen name="Plans" component={PlansScreen} options={{ title: 'Account plans' }} />
      <AppStack.Screen name="Reports" component={ReportsScreen} options={{ title: 'Reports' }} />
      <AppStack.Screen name="Watchlist" component={WatchlistScreen} options={{ title: 'Watchlist' }} />
      <AppStack.Screen name="Partner" component={PartnerScreen} options={{ title: 'Partner Program' }} />
      <AppStack.Screen name="Alerts" component={AlertsScreen} options={{ title: 'Price Alerts' }} />
      <AppStack.Screen name="Feedback" component={FeedbackScreen} options={{ title: 'Feedback' }} />
      <AppStack.Screen name="NewAccountTiers" component={NewAccountTiersScreen} options={{ title: 'Open account' }} />
      <AppStack.Screen name="NewAccountConfigure" component={NewAccountConfigureScreen} options={{ title: 'Configure account' }} />
      <AppStack.Screen name="Support" component={SupportScreen} options={{ title: 'Support' }} />
      <AppStack.Screen name="News" component={NewsScreen} options={{ title: 'Market News' }} />
      <AppStack.Screen name="Algo" component={ComingSoon} {...soon('hardware-chip-outline', 'Algo Trading', 'Automated strategies are coming to mobile.')} />
      <AppStack.Screen name="Analytics" component={ComingSoon} {...soon('analytics-outline', 'Analytics', 'Deep performance analytics coming soon.')} />
      <AppStack.Screen name="Notifications" component={ComingSoon} {...soon('notifications-outline', 'Notifications', 'In-app notifications coming soon.')} />
    </AppStack.Navigator>
  );
}

export default function RootNavigator() {
  const { user, loading } = useAuth();
  if (loading) return <Loader label="Loading…" />;
  return (
    <RootStack.Navigator screenOptions={{ headerShown: false }}>
      {user ? <RootStack.Screen name="App" component={AuthedApp} /> : <RootStack.Screen name="Login" component={LoginScreen} />}
    </RootStack.Navigator>
  );
}
