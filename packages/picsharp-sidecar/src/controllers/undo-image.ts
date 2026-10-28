import { Hono } from 'hono';
import { z } from 'zod';
import { undoImage } from '../services/undo-image';

const app = new Hono();
const schema = z.object({
  path: z.string().min(1),
  outputPath: z.string().min(1),
  originalTempPath: z.string().min(1),
  saveType: z.enum(['overwrite', 'save_as_new_file', 'save_to_new_folder']),
  outputVersion: z.string().optional(),
  convertResults: z
    .array(
      z.object({
        output_path: z.string().min(1),
        output_version: z.string().optional(),
      }),
    )
    .max(16)
    .optional(),
});

app.post('/', async (c) => {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ success: false, message: 'undo.no_allow_undo' }, 400);
  return c.json(await undoImage(parsed.data));
});

export default app;
