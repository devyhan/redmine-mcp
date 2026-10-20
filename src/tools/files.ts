/**
 * The `files` group: attachments and the upload-then-attach flow.
 *
 * Redmine attaches files in two steps: `POST /uploads.json` with the raw
 * bytes returns an upload token, and a later issue update references that
 * token in `uploads: [{token, filename, content_type}]`. This module exposes
 * both halves plus direct attachment download metadata.
 */

import { z } from 'zod';

import type { ToolDefinition, ToolDeps, ToolModule } from '../contracts.js';
import { GROUPS } from './groups.js';

const GROUP = GROUPS['files']!;

const READ_SCOPES = [...GROUP.readScopes];
const WRITE_SCOPES = [...GROUP.readScopes, ...GROUP.writeScopes];

const getInput = z.object({
  id: z.number().int().describe('Attachment id.'),
});

const downloadInput = z.object({
  id: z.number().int().describe('Attachment id.'),
  maxBytes: z.number().int().min(1).max(1_000_000).default(200_000).describe('Download cap; larger files are refused with their metadata.'),
});

const uploadInput = z.object({
  filename: z.string().min(1).describe('Filename Redmine stores.'),
  content_base64: z.string().min(1).describe('Raw file bytes, base64-encoded.'),
  content_type: z.string().default('application/octet-stream').describe('MIME type sent with the upload.'),
});

const projectFilesInput = z.object({
  project_id: z.union([z.number().int(), z.string()]).describe('Project id or identifier.'),
});

export const filesModule: ToolModule = {
  group: GROUP,
  build({ redmine }: ToolDeps): ToolDefinition[] {
    return [
      {
        name: 'files_get_attachment',
        title: 'Get attachment metadata',
        description: 'Returns one attachment metadata (filename, size, content type, download URL).',
        inputSchema: getInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id } = getInput.parse(args);
          const res = await redmine.request<{ attachment: unknown }>({
            path: `/attachments/${id}.json`,
            scopes: READ_SCOPES,
          });
          return res.data.attachment;
        },
      },
      {
        name: 'files_download',
        title: 'Download a file',
        description:
          'Downloads an attachment and returns base64 bytes plus metadata. Text files ' +
          'come back decoded as well. Refuses files over maxBytes with metadata only.',
        inputSchema: downloadInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { id, maxBytes } = downloadInput.parse(args);
          const meta = await redmine.request<{ attachment: { filesize: number; filename: string; content_type: string } }>({
            path: `/attachments/${id}.json`,
            scopes: READ_SCOPES,
          });
          const attachment = meta.data.attachment;
          if (attachment.filesize > maxBytes) {
            return { refused: 'over maxBytes', attachment };
          }
          const res = await redmine.requestRaw({ path: `/attachments/download/${id}`, scopes: READ_SCOPES });
          const base64 = Buffer.from(res.bytes).toString('base64');
          const text = /^text\/|\/json$|textile|markdown/.test(res.contentType)
            ? Buffer.from(res.bytes).toString('utf8')
            : undefined;
          return { attachment, content_base64: base64, ...(text !== undefined ? { text } : {}) };
        },
      },
      {
        name: 'files_upload',
        title: 'Upload a file',
        description:
          'Uploads raw bytes and returns an upload token. Reference it from issues_create ' +
          'or issues_update via uploads: [{token, filename}]. Tokens expire with the session.',
        inputSchema: uploadInput,
        write: true,
        scopes: WRITE_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { filename, content_base64, content_type } = uploadInput.parse(args);
          const bytes = Buffer.from(content_base64, 'base64');
          if (bytes.length === 0) throw new Error('content_base64 decoded to zero bytes.');
          const res = await redmine.requestRaw({
            path: '/uploads.json',
            method: 'POST',
            query: { filename },
            contentType: content_type,
            body: new Uint8Array(bytes),
            scopes: WRITE_SCOPES,
          });
          const payload = JSON.parse(Buffer.from(res.bytes).toString('utf8')) as { upload: { token: string } };
          return { token: payload.upload.token, filename };
        },
      },
      {
        name: 'files_list_project_files',
        title: "List a project's files",
        description: "Lists the files attached to a project's Files module.",
        inputSchema: projectFilesInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { project_id } = projectFilesInput.parse(args);
          const res = await redmine.request<{ files: unknown[]; total_count?: number }>({
            path: `/projects/${project_id}/files.json`,
            scopes: READ_SCOPES,
          });
          return { total_count: res.totalCount, files: res.data.files };
        },
      },
      {
        name: 'files_list_documents',
        title: "List a project's documents",
        description: "Lists the documents of a project's Documents module. Needs Redmine 7.1+.",
        inputSchema: projectFilesInput,
        scopes: READ_SCOPES,
        group: GROUP.name,
        handler: async (args) => {
          const { project_id } = projectFilesInput.parse(args);
          const res = await redmine.request<{ documents: unknown[]; total_count?: number }>({
            path: `/projects/${project_id}/documents.json`,
            scopes: READ_SCOPES,
          });
          return { total_count: res.totalCount, documents: res.data.documents };
        },
      },
    ];
  },
};
