import * as ImagePicker from 'expo-image-picker';

/**
 * Pick an image from the library and return it as base64 (no data: prefix),
 * matching what the backend KYC / deposit-proof endpoints expect. Returns null
 * if the user cancels or denies permission.
 */
export async function pickImageBase64() {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    base64: true,
    quality: 0.6,
    allowsEditing: false,
  });
  if (res.canceled || !res.assets || !res.assets[0]) return null;
  const a = res.assets[0];
  return {
    base64: a.base64,
    mimeType: a.mimeType || 'image/jpeg',
    fileName: a.fileName || `upload-${Date.now()}.jpg`,
    uri: a.uri,
  };
}
