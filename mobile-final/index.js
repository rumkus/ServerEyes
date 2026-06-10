/**
 * @format
 */

import {AppRegistry} from 'react-native';
import messaging from '@react-native-firebase/messaging';
import App from './App';
import {name as appName} from './app.json';

messaging().setBackgroundMessageHandler(async (remoteMessage) => {
  // Solo log, no procesamos en background
});

AppRegistry.registerComponent(appName, () => App);
