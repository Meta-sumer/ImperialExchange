import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * Hand a CSV the app built itself to the share sheet — the phone's
 * "download". Orders.jsx builds its Trade History report in the browser and
 * clicks an `<a download>`; there is no downloads folder here, so the file is
 * written to the cache and the trader chooses where it goes (Files, Drive,
 * mail…). Server-built exports go through reports.api `exportReportCsv`.
 *
 * `bom` prepends U+FEFF, as the web does for this report, so Excel opens the
 * UTF-8 (₹, →, —) correctly. Returns the file's URI.
 */
export const BOM = '﻿';

export const shareCsv = async (
  filename: string,
  csv: string,
  opts: { bom?: boolean; dialogTitle?: string } = {},
): Promise<string> => {
  const file = new File(Paths.cache, filename);
  file.create({ overwrite: true });
  file.write(opts.bom ? `${BOM}${csv}` : csv);
  // A file left in the cache with no way to reach it is not a download.
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(file.uri, {
    mimeType: 'text/csv',
    UTI: 'public.comma-separated-values-text',
    dialogTitle: opts.dialogTitle ?? filename,
  });
  return file.uri;
};
