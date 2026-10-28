import { Sharp } from 'sharp';
import { ConvertFormat } from '../constants';
import path from 'node:path';
import { captureError } from '../utils';
import { imageOutputRecords } from './output-records';

export async function convert(
  stream: Sharp,
  outputPath: string,
  format: ConvertFormat,
  alpha: string,
) {
  try {
    const { result, outputVersion } = await imageOutputRecords().publishTracked(
      outputPath,
      async (temporary) => {
        switch (format) {
          case ConvertFormat.PNG:
            return stream.png().toFile(temporary);
          case ConvertFormat.JPG:
            return stream.flatten({ background: alpha }).jpeg().toFile(temporary);
          case ConvertFormat.WEBP:
            return stream.webp().toFile(temporary);
          case ConvertFormat.AVIF:
            return stream.avif().toFile(temporary);
          default:
            throw new Error(`Unsupported convert format: ${format}`);
        }
      },
    );
    return {
      success: true,
      output_path: outputPath,
      output_version: outputVersion,
      format,
      info: result,
    };
  } catch (error: any) {
    captureError(error);
    return {
      success: false,
      format,
      error_msg: error instanceof Error ? error.message : error.toString(),
    };
  }
}

export async function bulkConvert(
  stream: Sharp,
  originalExt: string,
  outputName: string,
  outputDir: string,
  types: ConvertFormat[],
  alpha: string,
) {
  const tasks = [];
  originalExt = originalExt.startsWith('.') ? originalExt.slice(1) : originalExt;
  for (const type of types) {
    if (type === originalExt || (type === ConvertFormat.JPG && originalExt === 'jpeg')) {
      continue;
    }
    const outputPath = path.join(outputDir, `${outputName}.${type}`);
    tasks.push(convert(stream.clone(), outputPath, type, alpha));
  }
  return Promise.all(tasks);
}
