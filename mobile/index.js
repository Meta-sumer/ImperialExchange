// gesture-handler MUST be the very first import in the app entry.
import 'react-native-gesture-handler';
import { registerRootComponent } from 'expo';
import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App)
// and sets up the environment for Expo Go and native builds alike.
registerRootComponent(App);
