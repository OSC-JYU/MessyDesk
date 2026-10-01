// Service ids (queue topics) and message roles the backend itself relies on. These names are
// part of the contract with MD-consumers and the services, so they must not change.

export const SERVICE = {
    /** md-sharp attached as the thumbnail topic. */
    THUMBNAILER: 'md-thumbnailer',
    /** Image operations (EXIF rotation, service-group logos). */
    SHARP: 'md-sharp',
    /** PDF thumbnails for uploads and versions. */
    POPPLER: 'md-poppler',
    /** PDF thumbnails for split pages. */
    POPPLER_FS: 'md-poppler_fs',
    /** PDF splitter used by the import pipeline. */
    PDF_SPLITTER: 'md-pypdf_fs',
    /** Older name of the splitter, still recognised in callbacks. */
    PDF_SPLITTER_LEGACY: 'md-pdf-splitter_fs',
    ZIP: 'md-zip_fs',
    SOLR: 'md-solr',
} as const;

export const ROLE = {
    THUMBNAIL: 'thumbnail',
    THUMBNAILS: 'thumbnails',
    INTERNAL_VERSIONING: 'internal_versioning',
    EXIF_ROTATE: 'exif_rotate',
    IMPORT: 'import',
} as const;

export const THUMBNAIL_PARAMS = { width: 800, type: 'jpeg' };
export const PDF_THUMBNAIL_PARAMS = { page: 1, previewResolution: 150, thumbnailResolution: 80 };
