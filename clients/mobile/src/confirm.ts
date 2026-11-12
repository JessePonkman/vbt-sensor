// A yes/no question that works on the phone (native alert) and in the browser
// preview (Alert.alert does nothing on react-native-web).
import { Alert, Platform } from 'react-native';

export function confirmAsync(title: string, message: string, yesLabel = 'Aceptar'): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(typeof window !== 'undefined' && window.confirm(`${title}\n\n${message}`));
  }
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'Cancelar', style: 'cancel', onPress: () => resolve(false) },
      { text: yesLabel, style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}
