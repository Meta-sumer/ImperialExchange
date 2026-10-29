import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';

import { KYC_ALLOWED_MIME } from '@/types/user';
import { kycFileName, kycMimeType } from '@/utils/profile';

/**
 * Getting a KYC document off the phone — the web's `<input type="file"
 * accept="image/jpeg,image/png,image/webp,application/pdf">`.
 *
 * A phone browser's file input offers the camera, the photo library and the
 * file browser; the three sources here are those three. Nothing is read
 * until a file is chosen, and the bytes are read only after the size and
 * type checks pass (KycTab), so a wrong 50 MB file never enters memory.
 */
export type KycSource = 'camera' | 'library' | 'files';

export interface PickedKycFile {
  uri: string;
  name: string;
  mimeType: string;
  /** Bytes, when the picker could say. */
  size: number | null;
  /**
   * True for the photo pickers, which write a re-encoded copy: its real
   * type is settled from the bytes once they are read (sniffKycMime).
   * A browsed file is sent as the file it is, as on the web.
   */
  reencoded: boolean;
}

export type KycPick =
  | { ok: true; file: PickedKycFile }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'denied'; message: string }
  /** Refused earlier for good — the system will not ask again; only Settings can undo it. */
  | { ok: false; reason: 'blocked' };

export const CAMERA_DENIED = 'Allow camera access to photograph your document.';
export const CAMERA_BLOCKED_TITLE = 'Camera access is off';
export const CAMERA_BLOCKED =
  'Camera access is turned off for this app. Turn it on in Settings to photograph your document, or choose a photo or file instead.';

// Images come back re-encoded as JPEG where the platform would otherwise
// hand over HEIC (an iPhone's default), which the server does not accept.
const IMAGE_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  allowsMultipleSelection: false,
  quality: 0.9,
  exif: false,
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

/**
 * The picked photo as the file it WROTE, not the one it was made from.
 * `asset.uri` is the picker's output, named for its encoding on both
 * platforms; Android's `mimeType` and `fileName` describe the gallery
 * source instead (a HEIC original comes back as `image/heic` with JPEG
 * bytes at a `.jpeg` uri). The reported type is used only when the uri
 * names none of the accepted formats.
 */
const fromImage = (asset: ImagePicker.ImagePickerAsset, docType: string): PickedKycFile => {
  const mimeType = kycMimeType(null, asset.uri) || kycMimeType(asset.mimeType, asset.fileName || asset.uri);
  return {
    uri: asset.uri,
    name: kycFileName(asset.fileName, asset.uri, docType, mimeType),
    mimeType,
    size: typeof asset.fileSize === 'number' ? asset.fileSize : null,
    reencoded: true,
  };
};

export const pickKycFile = async (source: KycSource, docType: string): Promise<KycPick> => {
  if (source === 'camera') {
    // Once refused for good (iOS after the first "Don't Allow", Android
    // after "Don't allow" twice), a request returns at once with no dialog —
    // telling the user to "allow" it then points nowhere they can go.
    const current = await ImagePicker.getCameraPermissionsAsync();
    if (!current.granted && current.canAskAgain === false) return { ok: false, reason: 'blocked' };
    const perm = current.granted ? current : await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return { ok: false, reason: 'denied', message: CAMERA_DENIED };
    const res = await ImagePicker.launchCameraAsync(IMAGE_OPTIONS);
    const asset = res.canceled ? null : res.assets?.[0];
    return asset ? { ok: true, file: fromImage(asset, docType) } : { ok: false, reason: 'cancelled' };
  }

  if (source === 'library') {
    // The system photo picker needs no permission prompt on Android or iOS 14+.
    const res = await ImagePicker.launchImageLibraryAsync(IMAGE_OPTIONS);
    const asset = res.canceled ? null : res.assets?.[0];
    return asset ? { ok: true, file: fromImage(asset, docType) } : { ok: false, reason: 'cancelled' };
  }

  const res = await DocumentPicker.getDocumentAsync({
    type: [...KYC_ALLOWED_MIME],
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = res.canceled ? null : res.assets?.[0];
  if (!asset) return { ok: false, reason: 'cancelled' };
  const mimeType = kycMimeType(asset.mimeType, asset.name || asset.uri);
  return {
    ok: true,
    file: {
      uri: asset.uri,
      name: kycFileName(asset.name, asset.uri, docType, mimeType),
      mimeType,
      size: typeof asset.size === 'number' ? asset.size : null,
      reencoded: false,
    },
  };
};

/** The file's bytes as base64 — the web's FileReader `readAsDataURL` minus the prefix. */
export const readBase64 = (uri: string): Promise<string> => new File(uri).base64();
