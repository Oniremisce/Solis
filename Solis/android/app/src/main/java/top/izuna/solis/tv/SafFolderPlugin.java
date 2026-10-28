package top.izuna.solis.tv;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.lonx.audiotag.TagLib;
import com.lonx.audiotag.model.AudioProperties;
import com.lonx.audiotag.model.AudioPropertiesReadStyle;
import com.lonx.audiotag.model.Metadata;
import com.lonx.audiotag.model.Picture;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * SAF (Storage Access Framework) 桥：为本地音乐导入提供目录选择、枚举与读取能力。
 * WebView 没有 File System Access API，这里用 ACTION_OPEN_DOCUMENT_TREE 补齐。
 * 选中目录后立即 takePersistableUriPermission，重启后重扫描仍可访问。
 */
@CapacitorPlugin(name = "SafFolder")
public class SafFolderPlugin extends Plugin {

    private static final int MAX_READ_BYTES = 96 * 1024 * 1024;
    /** readHead 的单次上限：ID3/FLAC/Vorbis 标签区极少超过 4MB。 */
    private static final int MAX_HEAD_BYTES = 4 * 1024 * 1024;
    // docId 解析缓存：treeUri|path -> documentId，避免每次枚举都从根开始逐层查。
    private final Map<String, String> docIdCache = new ConcurrentHashMap<>();

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        startActivityForResult(call, intent, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("PICK_CANCELLED");
            return;
        }
        Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            call.reject("PICK_NO_URI");
            return;
        }
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                treeUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            );
        } catch (SecurityException ignored) {
            // 个别机型不授予可持久化权限时仍按会话内可用处理。
        }
        JSObject out = new JSObject();
        out.put("treeUri", treeUri.toString());
        out.put("name", resolveTreeDisplayName(treeUri));
        call.resolve(out);
    }

    @PluginMethod
    public void list(PluginCall call) {
        String treeUriText = call.getString("treeUri", "");
        String path = call.getString("path", "");
        if (treeUriText.isEmpty()) {
            call.reject("INVALID_TREE_URI");
            return;
        }
        try {
            Uri treeUri = Uri.parse(treeUriText);
            String parentDocId = resolveDocId(treeUri, path);
            Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId);
            ContentResolver resolver = getContext().getContentResolver();
            JSArray entries = new JSArray();
            try (Cursor cursor = resolver.query(childrenUri, new String[] {
                Document.COLUMN_DISPLAY_NAME,
                Document.COLUMN_MIME_TYPE,
                Document.COLUMN_SIZE,
                Document.COLUMN_LAST_MODIFIED
            }, null, null, null)) {
                if (cursor == null) {
                    call.reject("LIST_QUERY_FAILED");
                    return;
                }
                while (cursor.moveToNext()) {
                    JSObject entry = new JSObject();
                    entry.put("name", cursor.getString(0));
                    entry.put("isDir", Document.MIME_TYPE_DIR.equals(cursor.getString(1)));
                    entry.put("size", cursor.isNull(2) ? 0L : cursor.getLong(2));
                    entry.put("mtime", cursor.isNull(3) ? 0L : cursor.getLong(3));
                    entries.put(entry);
                }
            }
            JSObject out = new JSObject();
            out.put("entries", entries);
            call.resolve(out);
        } catch (Exception error) {
            docIdCache.keySet().removeIf(key -> key.startsWith(treeUriText + "|"));
            call.reject("LIST_FAILED: " + error.getMessage());
        }
    }

    @PluginMethod
    public void read(PluginCall call) {
        String treeUriText = call.getString("treeUri", "");
        String path = call.getString("path", "");
        if (treeUriText.isEmpty()) {
            call.reject("INVALID_TREE_URI");
            return;
        }
        try {
            Uri treeUri = Uri.parse(treeUriText);
            String docId = resolveDocId(treeUri, path);
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
            ContentResolver resolver = getContext().getContentResolver();
            try (InputStream input = resolver.openInputStream(docUri)) {
                if (input == null) {
                    call.reject("ENOENT");
                    return;
                }
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[64 * 1024];
                long total = 0;
                int n;
                while ((n = input.read(chunk)) > 0) {
                    total += n;
                    if (total > MAX_READ_BYTES) {
                        call.reject("FILE_TOO_LARGE");
                        return;
                    }
                    buffer.write(chunk, 0, n);
                }
                JSObject out = new JSObject();
                out.put("base64", Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP));
                out.put("size", total);
                out.put("name", path.isEmpty() ? "" : path.substring(path.lastIndexOf('/') + 1));
                call.resolve(out);
            }
        } catch (SecurityException error) {
            call.reject("PERMISSION_LOST: " + error.getMessage());
        } catch (Exception error) {
            call.reject("READ_FAILED: " + error.getMessage());
        }
    }

    /**
     * 原生元数据快路径：MediaMetadataRetriever 只读文件头即可拿到标题/艺术家/专辑/时长/码率等，
     * 不需要把整个音频文件经 base64 桥整读到 WebView。封面图按需返回。
     */
    @PluginMethod
    public void getAudioMeta(PluginCall call) {
        String treeUriText = call.getString("treeUri", "");
        String path = call.getString("path", "");
        boolean includePicture = call.getBoolean("includePicture", false);
        if (treeUriText.isEmpty()) {
            call.reject("INVALID_TREE_URI");
            return;
        }
        try {
            Uri treeUri = Uri.parse(treeUriText);
            String docId = resolveDocId(treeUri, path);
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
            ContentResolver resolver = getContext().getContentResolver();
            AssetFileDescriptor descriptor = null;
            MediaMetadataRetriever retriever = new MediaMetadataRetriever();
            try {
                descriptor = resolver.openAssetFileDescriptor(docUri, "r");
                if (descriptor == null) {
                    call.reject("ENOENT");
                    return;
                }
                retriever.setDataSource(descriptor.getFileDescriptor());
                JSObject out = new JSObject();
                putTextMeta(out, "title", retriever, MediaMetadataRetriever.METADATA_KEY_TITLE);
                putTextMeta(out, "artist", retriever, MediaMetadataRetriever.METADATA_KEY_ARTIST);
                putTextMeta(out, "albumArtist", retriever, MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST);
                putTextMeta(out, "album", retriever, MediaMetadataRetriever.METADATA_KEY_ALBUM);
                putLongMeta(out, "durationMs", retriever, MediaMetadataRetriever.METADATA_KEY_DURATION);
                putLongMeta(out, "bitrate", retriever, MediaMetadataRetriever.METADATA_KEY_BITRATE);
                putIndexedNumberMeta(out, "trackNumber", retriever, MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    putIndexedNumberMeta(out, "discNumber", retriever, MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER);
                }
                if (includePicture) {
                    byte[] picture = retriever.getEmbeddedPicture();
                    String mime = picture != null ? detectImageMimeType(picture) : null;
                    if (picture != null && mime != null) {
                        out.put("pictureBase64", Base64.encodeToString(picture, Base64.NO_WRAP));
                        out.put("pictureMime", mime);
                    }
                }
                call.resolve(out);
            } finally {
                try {
                    retriever.release();
                } catch (Exception ignored) {
                }
                if (descriptor != null) {
                    try {
                        descriptor.close();
                    } catch (IOException ignored) {
                    }
                }
            }
        } catch (SecurityException error) {
            call.reject("PERMISSION_LOST: " + error.getMessage());
        } catch (Exception error) {
            call.reject("META_FAILED: " + error.getMessage());
        }
    }

    /**
     * TagLib 原生解析（移植自 Lyrico lyrico-audiotag）：文件描述符直接交给 native 层，
     * 全程不经 base64 桥整读文件，即可拿到完整内嵌标签（多值字段、内嵌歌词、ReplayGain、封面）。
     * fd 按 Lyrico FdUtils 方式 dup+detach 后交给 native；native 侧 FileStream 析构时会 fclose，
     * 因此这里不重复关闭这两个 fd，Java 侧 PFD 最后独立关闭。
     */
    @PluginMethod
    public void parseAudioMeta(PluginCall call) {
        String treeUriText = call.getString("treeUri", "");
        String path = call.getString("path", "");
        boolean includePicture = call.getBoolean("includePicture", true);
        if (treeUriText.isEmpty()) {
            call.reject("INVALID_TREE_URI");
            return;
        }
        AssetFileDescriptor descriptor = null;
        try {
            Uri treeUri = Uri.parse(treeUriText);
            String docId = resolveDocId(treeUri, path);
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
            ContentResolver resolver = getContext().getContentResolver();
            descriptor = resolver.openAssetFileDescriptor(docUri, "r");
            if (descriptor == null) {
                call.reject("ENOENT");
                return;
            }
            ParcelFileDescriptor pfd = descriptor.getParcelFileDescriptor();
            int metaFd = pfd.dup().detachFd();
            int propsFd = pfd.dup().detachFd();

            JSObject out = new JSObject();
            Metadata metadata = null;
            try {
                metadata = TagLib.getMetadata(metaFd, includePicture);
            } catch (Throwable ignored) {
                // 个别损坏文件解析抛错时按无标签处理，音频属性仍单独解析。
            }
            try {
                AudioProperties audio = TagLib.getAudioProperties(propsFd, AudioPropertiesReadStyle.Average);
                if (audio != null) {
                    out.put("durationMs", (long) audio.getLength());
                    out.put("bitrateKbps", (long) audio.getBitrate());
                    out.put("sampleRate", (long) audio.getSampleRate());
                    out.put("channels", (long) audio.getChannels());
                }
            } catch (Throwable ignored) {
            }

            if (metadata != null) {
                JSObject props = new JSObject();
                for (Map.Entry<String, String[]> entry : metadata.getPropertyMap().entrySet()) {
                    JSArray values = new JSArray();
                    for (String value : entry.getValue()) {
                        if (value != null && !value.isEmpty()) values.put(value);
                    }
                    props.put(entry.getKey(), values);
                }
                out.put("props", props);

                if (includePicture) {
                    Picture cover = pickFrontCover(metadata.getPictures());
                    if (cover != null && cover.getData() != null && cover.getData().length > 0) {
                        byte[] data = cover.getData();
                        String mime = cover.getMimeType();
                        if (mime == null || !mime.startsWith("image/")) {
                            mime = detectImageMimeType(data);
                        }
                        if (mime != null) {
                            out.put("pictureBase64", Base64.encodeToString(data, Base64.NO_WRAP));
                            out.put("pictureMime", mime);
                        }
                    }
                }
            }
            call.resolve(out);
        } catch (SecurityException error) {
            call.reject("PERMISSION_LOST: " + error.getMessage());
        } catch (Exception error) {
            call.reject("META_FAILED: " + error.getMessage());
        } finally {
            if (descriptor != null) {
                try {
                    descriptor.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    /** 优先 Front Cover 类型，其次任意非空封面（与 Lyrico getFrontCover 的取图语义一致）。 */
    private Picture pickFrontCover(Picture[] pictures) {
        if (pictures == null) return null;
        Picture fallback = null;
        for (Picture picture : pictures) {
            if (picture == null || picture.getData() == null || picture.getData().length == 0) continue;
            if ("Front Cover".equalsIgnoreCase(picture.getPictureType())) return picture;
            if (fallback == null) fallback = picture;
        }
        return fallback;
    }

    /** 只读文件头部：歌词/ReplayGain/封面等标签都在文件头，按需取前 N 字节给 JS 解析，避免整读。 */
    @PluginMethod
    public void readHead(PluginCall call) {
        String treeUriText = call.getString("treeUri", "");
        String path = call.getString("path", "");
        int maxBytes = call.getInt("maxBytes", 2 * 1024 * 1024);
        if (treeUriText.isEmpty()) {
            call.reject("INVALID_TREE_URI");
            return;
        }
        if (maxBytes < 0) maxBytes = 0;
        if (maxBytes > MAX_HEAD_BYTES) maxBytes = MAX_HEAD_BYTES;
        try {
            Uri treeUri = Uri.parse(treeUriText);
            String docId = resolveDocId(treeUri, path);
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
            ContentResolver resolver = getContext().getContentResolver();
            try (InputStream input = resolver.openInputStream(docUri)) {
                if (input == null) {
                    call.reject("ENOENT");
                    return;
                }
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[64 * 1024];
                long total = 0;
                int n;
                while (total < maxBytes && (n = input.read(chunk, 0, (int) Math.min(chunk.length, maxBytes - total))) > 0) {
                    buffer.write(chunk, 0, n);
                    total += n;
                }
                JSObject out = new JSObject();
                out.put("base64", Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP));
                out.put("size", total);
                call.resolve(out);
            }
        } catch (SecurityException error) {
            call.reject("PERMISSION_LOST: " + error.getMessage());
        } catch (Exception error) {
            call.reject("READ_FAILED: " + error.getMessage());
        }
    }

    private void putTextMeta(JSObject out, String key, MediaMetadataRetriever retriever, int metadataKey) {
        String value = retriever.extractMetadata(metadataKey);
        if (value != null && !value.isEmpty()) out.put(key, value);
    }

    private void putLongMeta(JSObject out, String key, MediaMetadataRetriever retriever, int metadataKey) {
        String value = retriever.extractMetadata(metadataKey);
        if (value == null) return;
        try {
            out.put(key, (long) Double.parseDouble(value));
        } catch (NumberFormatException ignored) {
        }
    }

    /** "3" 或 "3/12" 形式的序号取前半段。 */
    private void putIndexedNumberMeta(JSObject out, String key, MediaMetadataRetriever retriever, int metadataKey) {
        String value = retriever.extractMetadata(metadataKey);
        if (value == null) return;
        int slash = value.indexOf('/');
        String head = slash > 0 ? value.substring(0, slash) : value;
        try {
            out.put(key, (int) Double.parseDouble(head.trim()));
        } catch (NumberFormatException ignored) {
        }
    }

    private String detectImageMimeType(byte[] data) {
        if (data.length >= 3 && (data[0] & 0xFF) == 0xFF && (data[1] & 0xFF) == 0xD8) return "image/jpeg";
        if (data.length >= 8 && (data[0] & 0xFF) == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G') return "image/png";
        if (data.length >= 12 && data[0] == 'R' && data[1] == 'I' && data[2] == 'F' && data[3] == 'F'
            && data[8] == 'W' && data[9] == 'E' && data[10] == 'B' && data[11] == 'P') return "image/webp";
        if (data.length >= 6 && data[0] == 'G' && data[1] == 'I' && data[2] == 'F' && data[3] == '8') return "image/gif";
        return null;
    }

    /** 从树的根文档开始，按显示名逐层下钻到 path 对应的 documentId。 */
    private String resolveDocId(Uri treeUri, String path) throws Exception {
        String cacheKey = treeUri + "|" + path;
        String cached = docIdCache.get(cacheKey);
        if (cached != null) return cached;

        ContentResolver resolver = getContext().getContentResolver();
        String docId = DocumentsContract.getTreeDocumentId(treeUri);
        if (path != null && !path.isEmpty()) {
            for (String segment : path.split("/")) {
                if (segment.isEmpty()) continue;
                docId = findChildDocId(resolver, treeUri, docId, segment);
            }
        }
        docIdCache.put(cacheKey, docId);
        return docId;
    }

    private String findChildDocId(ContentResolver resolver, Uri treeUri, String parentDocId, String segment) throws Exception {
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId);
        try (Cursor cursor = resolver.query(childrenUri, new String[] {
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME
        }, null, null, null)) {
            if (cursor == null) throw new Exception("CHILD_QUERY_FAILED");
            String fallback = null;
            while (cursor.moveToNext()) {
                String childDocId = cursor.getString(0);
                String name = cursor.getString(1);
                if (segment.equals(name)) return childDocId;
                if (fallback == null && segment.equalsIgnoreCase(name)) fallback = childDocId;
            }
            if (fallback != null) return fallback;
            throw new Exception("ENOENT: " + segment);
        }
    }

    private String resolveTreeDisplayName(Uri treeUri) {
        try {
            String treeDocId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, treeDocId);
            try (Cursor cursor = getContext().getContentResolver().query(docUri, new String[] {
                Document.COLUMN_DISPLAY_NAME
            }, null, null, null)) {
                if (cursor != null && cursor.moveToFirst() && cursor.getString(0) != null) {
                    return cursor.getString(0);
                }
            }
        } catch (Exception ignored) {
            // 显示名拿不到时交给 JS 侧用 treeUri 兜底。
        }
        return "folder";
    }
}
