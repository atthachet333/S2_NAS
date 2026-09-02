# UPLOAD SECURITY

Uploads are authenticated and destination-authorized. Multipart limits and the storage stream enforce the configured byte ceiling. User filenames are data, never paths; validation rejects traversal, separators, control characters, reserved names, and invalid Unicode-normalized names.

The backend streams into a temporary file, calculates SHA-256, checks actual signatures against the safe MIME policy, and rejects empty/oversized uploads. Duplicate content and duplicate names require explicit client decisions. Staged files are removed on failure.

Inline preview has a strict allowlist. SVG and HTML are never inlined. Image thumbnails use the authenticated content endpoint only for JPEG, PNG, WEBP, and GIF up to a modest client-side size threshold, with lazy loading and fallback icons. Large supported images use the normal preview flow; Phase D does not generate server-side resized thumbnails.

The file security scanner status is `NOT_CONFIGURED`. The product must not display “safe” or “scanned” badges and must not claim malware scanning occurred. A future ClamAV adapter belongs after staging/signature validation and before `commitStagedFile`; a positive or unavailable required scanner must abort and discard the staged file.
