import logger from "./logger.js";
import { prisma } from "./prisma.js";
import zcconfig from "./config/zcconfig.js";
import { createHash } from "crypto";
import { putObject, getObject } from "./objectStorage.js";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import { fileTypeFromBuffer } from "file-type";
import { authorize } from "./auth/authorization.js";
import { assertCanWrite, canViewContent, sanitizeProfile, sanitizeProfiles, visibleWhere } from "./moderation/visibility.js";
import { ModerationError } from "./moderation/policy.js";

async function assertUploadAllowed(res, purpose = 'general') {
  const actorId = res.locals?.userid;
  await assertCanWrite(actorId, 'assets', 'create');
  const decision = await authorize({
    actorId, tokenType: res.locals?.tokenType, tokenScopes: res.locals?.scopes || [],
    requiredScope: purpose === 'avatar' ? 'user:update' : 'asset:create',
    category: purpose === 'avatar' ? 'profile' : 'assets', action: purpose === 'avatar' ? 'update' : 'create',
  });
  if (!decision.allowed) throw new ModerationError(decision.status || 403, decision.code, decision.message);
}

async function visibleExistingAsset(asset, viewerId) {
  if (asset && !await canViewContent('asset', asset, viewerId)) {
    throw new ModerationError(404, 'RESOURCE_NOT_FOUND', '素材不存在');
  }
  return asset;
}

// 支持的文件类型
const SUPPORTED_IMAGE_TYPES = [
  "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/svg+xml"
];

const SUPPORTED_AUDIO_TYPES = [
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg", "audio/aac", "audio/flac"
];
const SUPPORTED_FONTS_TYPES = [
  "font/ttf", "font/otf", "font/woff", "font/woff2", "font/eot", "font/svg"
];

const SUPPORTED_TYPES = [...SUPPORTED_IMAGE_TYPES, ...SUPPORTED_AUDIO_TYPES, ...SUPPORTED_FONTS_TYPES];

/**
 * 使用 file-type 库检测文件类型
 * @param {Buffer} buffer 文件缓冲区
 * @returns {Promise<Object>} 包含 mimeType 和 extension 的对象
 */
export async function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return { mimeType: null, extension: null };
  }

  try {
    const fileType = await fileTypeFromBuffer(buffer);

    if (fileType) {
      return {
        mimeType: fileType.mime,
        extension: fileType.ext
      };
    }

    // 如果 file-type 无法识别，尝试检测 SVG
    const textContent = buffer.toString('utf8', 0, Math.min(buffer.length, 200));
    if (textContent.includes('<svg') || textContent.includes('<?xml')) {
        return { mimeType: 'image/svg+xml', extension: 'svg' };
    }

    return { mimeType: null, extension: null };
  } catch (error) {
    logger.error("文件类型检测失败:", error);
    return { mimeType: null, extension: null };
  }
}

/**
 * 验证文件类型（基于文件内容检测和前端MIME类型匹配）
 * @param {Buffer} buffer 文件缓冲区
 * @param {string} frontendMimeType 前端提供的MIME类型
 * @returns {Promise<Object>} 包含检测结果的对象 { isValid: boolean, mimeType: string, extension: string }
 */
export async function validateFileTypeFromContent(buffer, frontendMimeType = null) {
  const detected = await detectFileType(buffer);

  if (!detected.mimeType) {
    return {
      isValid: false,
      mimeType: null,
      extension: null,
      error: '无法识别文件类型'
    };
  }

  // 检查检测到的MIME类型是否在支持列表中
  const isSupportedType = SUPPORTED_TYPES.includes(detected.mimeType);
  if (!isSupportedType) {
    return {
      isValid: false,
      mimeType: detected.mimeType,
      extension: detected.extension,
      error: `不支持的文件类型: ${detected.mimeType}`
    };
  }

  return {
    isValid: true,
    mimeType: detected.mimeType,
    extension: detected.extension,
    error: null
  };
}

/**
 * 生成MD5哈希
 * @param {Buffer} buffer 文件缓冲区
 * @returns {string} MD5哈希值
 */
export function generateMD5(buffer) {
  return createHash('md5').update(buffer).digest('hex');
}

/**
 * 获取文件扩展名
 * @param {string} filename 文件名
 * @returns {string} 扩展名
 */
export function getFileExtension(filename) {
  return filename.split('.').pop().toLowerCase();
}

/**
 * 获取MIME类型
 * @param {string} filename 文件名
 * @returns {string} MIME类型
 */
export function getMimeType(filename) {
  const ext = getFileExtension(filename);
  const mimeTypes = {
    // 图片
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    // 音频
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'aac': 'audio/aac',
    'flac': 'audio/flac'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/** Upload public assets through the shared S3 transport. */
export async function uploadToS3(buffer, key, contentType) {
  await putObject({ bucket: await zcconfig.get("s3.bucket"), key, body: buffer,
    contentType, acl: 'public-read' });
  return `${await zcconfig.get("s3.staticurl")}/${key}`;
}

export async function downloadFromS3(key) {
  return getObject({ bucket: await zcconfig.get("s3.bucket"), key });
}

/**
 * 统一的图片处理函数
 * @param {Buffer} buffer 原始图片缓冲区
 * @param {Object} options 处理选项
 * @returns {Promise<Object>} 处理结果
 */
export async function processImage(buffer, options = {}) {
  const {
    // 尺寸限制
    maxWidth = null,
    maxHeight = null,
    width = null,
    height = null,
    // 质量和格式
    quality = 85,
    format = 'webp', // 默认转换为 webp
    // 优化选项
    progressive = true,
    mozjpeg = true,
    // 安全选项
    sanitize = true,
    // 文件大小限制
    maxFileSize = null
  } = options;

  // 确保输入是Buffer
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("图片数据必须是Buffer类型");
  }

  if (buffer.length === 0) {
    throw new Error("图片数据为空");
  }

  let sharpInstance = sharp(buffer);

  try {
    // 获取图片信息
    const metadata = await sharpInstance.metadata();

    // 验证图片格式
    if (!metadata.format) {
      throw new Error("无法识别图片格式");
    }

    // 检查图片尺寸是否合理
    if (metadata.width > 10000 || metadata.height > 10000) {
      logger.warn("检测到异常大尺寸图片:", { width: metadata.width, height: metadata.height });
    }

    // 安全处理：强制移除所有元数据
    if (sanitize) {
      sharpInstance = sharpInstance.withMetadata({
        // 保留基本元数据，移除敏感信息
        density: metadata.density,
        // 不设置icc参数，让Sharp自动处理ICC配置文件
        exif: {} // 清空EXIF数据
      });
    }

    // 尺寸处理
    if (width && height) {
      // 精确尺寸
      sharpInstance = sharpInstance.resize(width, height, {
        fit: 'cover',
        position: 'center'
      });
    } else if (maxWidth || maxHeight) {
      // 按最大尺寸缩放，保持纵横比
      sharpInstance = sharpInstance.resize(maxWidth, maxHeight, {
        fit: 'inside',
        withoutEnlargement: true
      });
    }

    // 格式转换和质量设置
    switch (format) {
      case 'webp':
        sharpInstance = sharpInstance.webp({
          quality: Math.min(Math.max(quality, 1), 100),
          effort: 6, // 高质量压缩
          smartSubsample: true
        });
        break;
      case 'jpeg':
      case 'jpg':
        sharpInstance = sharpInstance.jpeg({
          quality: Math.min(Math.max(quality, 1), 100),
          progressive,
          mozjpeg,
          optimiseCoding: true
        });
        break;
      case 'png':
        sharpInstance = sharpInstance.png({
          quality: Math.min(Math.max(quality, 1), 100),
          compressionLevel: 9,
          adaptiveFiltering: true,
          palette: true
        });
        break;
      case 'avif':
        sharpInstance = sharpInstance.avif({
          quality: Math.min(Math.max(quality, 1), 100),
          effort: 6
        });
        break;
      default:
        // 如果不支持的格式，默认转为 webp
        sharpInstance = sharpInstance.webp({
          quality: Math.min(Math.max(quality, 1), 100),
          effort: 6
        });
        break;
    }

    let processedBuffer = await sharpInstance.toBuffer();

    // 验证输出Buffer
    if (!Buffer.isBuffer(processedBuffer) || processedBuffer.length === 0) {
      throw new Error("图片处理失败，输出数据无效");
    }

    // 文件大小检查
    if (maxFileSize && processedBuffer.length > maxFileSize) {
      // 如果超过限制，降低质量重新压缩
      let retryQuality = quality - 10;
      let retries = 0;

      while (processedBuffer.length > maxFileSize && retryQuality > 10 && retries < 5) {
        logger.info(`文件大小超限(${processedBuffer.length}>${maxFileSize})，降低质量重试: ${retryQuality}`);

        let retryInstance = sharp(buffer);
        if (sanitize) {
          retryInstance = retryInstance.withMetadata({
            // 不设置icc参数，让Sharp自动处理ICC配置文件
            exif: {}
          });
        }

        // 重新应用尺寸设置
        if (width && height) {
          retryInstance = retryInstance.resize(width, height, {
            fit: 'cover',
            position: 'center'
          });
        } else if (maxWidth || maxHeight) {
          retryInstance = retryInstance.resize(maxWidth, maxHeight, {
            fit: 'inside',
            withoutEnlargement: true
          });
        }

        // 重新应用格式设置
        switch (format) {
          case 'webp':
            retryInstance = retryInstance.webp({
              quality: retryQuality,
              effort: 6
            });
            break;
          case 'jpeg':
          case 'jpg':
            retryInstance = retryInstance.jpeg({
              quality: retryQuality,
              progressive,
              mozjpeg
            });
            break;
          case 'png':
            retryInstance = retryInstance.png({
              quality: retryQuality,
              compressionLevel: 9
            });
            break;
          case 'avif':
            retryInstance = retryInstance.avif({
              quality: retryQuality,
              effort: 6
            });
            break;
        }

        processedBuffer = await retryInstance.toBuffer();
        retryQuality -= 10;
        retries++;
      }

      if (processedBuffer.length > maxFileSize) {
        throw new Error(`无法将文件压缩到指定大小限制: ${maxFileSize} bytes`);
      }
    }

    // 获取最终图片信息
    const finalMetadata = await sharp(processedBuffer).metadata();

    return {
      buffer: processedBuffer,
      format: format,
      width: finalMetadata.width,
      height: finalMetadata.height,
      size: processedBuffer.length,
      originalSize: buffer.length,
      compressionRatio: (buffer.length - processedBuffer.length) / buffer.length,
      metadataRemoved: sanitize
    };
  } catch (error) {
    logger.error("图片处理失败:", error);
    throw new Error(`图片处理失败: ${error.message}`);
  }
}

/**
 * 处理音频转换
 * @param {string} inputPath 输入文件路径
 * @param {string} outputPath 输出文件路径
 * @param {Object} options 转换选项
 * @returns {Promise<void>}
 */
export async function processAudio(inputPath, outputPath, options = {}) {
  const { format = 'mp3', bitrate = '128k' } = options;

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat(format)
      .audioBitrate(bitrate)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

/**
 * 检查素材是否已存在
 * @param {string} md5 MD5哈希值
 * @returns {Promise<Object|null>} 素材记录
 */
export async function checkAssetExists(md5) {
  return await prisma.ow_assets.findUnique({
    where: { md5 }
  });
}

/**
 * 创建素材记录
 * @param {Object} data 素材数据
 * @returns {Promise<Object>} 创建的素材记录
 */
export async function createAssetRecord(data) {
  await assertCanWrite(data.uploaderId, 'assets', 'create');
  return await prisma.ow_assets.create({
    data: {
      md5: data.md5,
      filename: data.filename,
      extension: data.extension,
      mime_type: data.mimeType,
      file_size: data.fileSize,
      uploader_id: data.uploaderId,
      uploader_ip: data.uploaderIp,
      uploader_ua: data.uploaderUa,
      metadata: data.metadata,
      tags: data.tags,
      category: data.category
    }
  });
}

/**
 * 更新素材使用统计
 * @param {number} assetId 素材ID
 * @returns {Promise<void>}
 */
export async function updateAssetUsage(assetId) {
  await prisma.ow_assets.update({
    where: { id: assetId },
    data: {
      usage_count: {
        increment: 1
      },
      last_used_at: new Date()
    }
  });
}

/**
 * 获取素材列表
 * @param {Object} options 查询选项
 * @returns {Promise<Object>} 素材列表和分页信息
 */
export async function getAssetsList(options = {}) {
  const { page = 1, limit = 20, category, search, sortBy = "created_at", sortOrder = "desc" } = options;

  const where = { AND: [await visibleWhere('asset', options.viewerId)] };

  if (category) {
    where.category = category;
  }

  if (search) {
    where.OR = [
      { filename: { contains: search } },
      { tags: { contains: search } }
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [assets, total] = await Promise.all([
    prisma.ow_assets.findMany({
      where,
      skip,
      take: parseInt(limit),
      orderBy: { [sortBy]: sortOrder },
      include: {
        uploader: {
          select: {
            id: true,
            username: true,
            display_name: true
          }
        }
      }
    }),
    prisma.ow_assets.count({ where })
  ]);

  const uploaders = await sanitizeProfiles(assets.map(asset => asset.uploader), options.viewerId);
  assets.forEach((asset, index) => { asset.uploader = uploaders[index]; });
  return {
    assets,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  };
}

/**
 * 获取素材详情
 * @param {number} assetId 素材ID
 * @returns {Promise<Object|null>} 素材详情
 */
export async function getAssetDetails(assetId, viewerId = null) {
  const asset = await prisma.ow_assets.findUnique({
    where: { id: parseInt(assetId) },
    include: {
      uploader: {
        select: {
          id: true,
          username: true,
          display_name: true
        }
      }
    }
  });

  if (!asset || !await canViewContent('asset', asset, viewerId)) {
    return null;
  }
  asset.uploader = await sanitizeProfile(asset.uploader, viewerId);

  // 生成S3访问URL
  const s3Key = `assets/${asset.md5.substring(0, 2)}/${asset.md5.substring(2, 4)}/${asset.md5}.${asset.extension}`;
  const url = `${await zcconfig.get("s3.staticurl")}/${s3Key}`;

  return {
    ...asset,
    url
  };
}

/**
 * 获取素材统计信息
 * @returns {Promise<Object>} 统计信息
 */
export async function getAssetStats(viewerId = null) {
  const where = await visibleWhere('asset', viewerId);
  const stats = await prisma.ow_assets.groupBy({
    where,
    by: ['category'],
    _count: {
      id: true
    },
    _sum: {
      file_size: true
    }
  });

  return {
    totalAssets: stats.reduce((total, stat) => total + stat._count.id, 0),
    totalSize: stats.reduce((total, stat) => total + (stat._sum.file_size || 0), 0),
    byCategory: stats.map(stat => ({
      category: stat.category,
      count: stat._count.id,
      size: stat._sum.file_size
    }))
  };
}

/**
 * 简化的图片上传处理（仅支持图片，自动转换为PNG）
 * @param {Object} file 上传的文件
 * @param {Object} options 处理选项
 * @param {Object} res Express响应对象
 * @param {string} ip IP地址
 * @param {string} userAgent User Agent
 * @returns {Promise<Object>} 处理结果
 */
export async function processSimpleImageUpload(file, options, res, ip, userAgent) {
  await assertUploadAllowed(res);
  const { quality = 80, tags, category } = options;

  // 使用Sharp检测和处理图片
  let sharpInstance;
  try {
    sharpInstance = sharp(file.buffer);
    const metadata = await sharpInstance.metadata();

    if (!metadata.format) {
      throw new Error("不是有效的图片文件");
    }
  } catch (error) {
    throw new Error("不是有效的图片文件");
  }

  // 转换为PNG
  const result = await processImage(file.buffer, {
    compress: true,
    convertToPng: true,
    quality: parseInt(quality),
    sanitize: true
  });

  const processedBuffer = result.buffer;
  const finalExtension = 'png';
  const finalMimeType = 'image/png';

  // 生成MD5（基于处理后的最终文件）
  const md5 = generateMD5(processedBuffer);

  // 检查素材是否已存在
  const existingAsset = await visibleExistingAsset(await checkAssetExists(md5), res.locals.userid);
  if (existingAsset) {
    return {
      success: true,
      message: "素材已存在",
      asset: existingAsset
    };
  }

  const metadata = {
    width: result.width,
    height: result.height,
    originalFormat: result.format
  };

  // 生成S3存储路径
  const s3Key = `assets/${md5.substring(0, 2)}/${md5.substring(2, 4)}/${md5}.${finalExtension}`;

  // 上传到S3
  const s3Url = await uploadToS3(processedBuffer, s3Key, finalMimeType);

  // 创建数据库记录
  const assetData = {
    md5,
    filename: file.originalname,
    extension: finalExtension,
    mimeType: finalMimeType,
    fileSize: processedBuffer.length,
    uploaderId: res.locals.userid,
    uploaderIp: ip,
    uploaderUa: userAgent,
    metadata,
    tags: tags || '',
    category: category || 'images'
  };

  const asset = await createAssetRecord(assetData);

  return {
    success: true,
    message: "图片上传成功",
    asset: {
      ...asset,
      url: s3Url
    }
  };
}

/**
 * 统一的文件上传函数（根据用途进行不同处理）
 * @param {Object} file 上传的文件
 * @param {Object} options 处理选项
 * @param {Object} res Express响应对象
 * @param {string} ip IP地址
 * @param {string} userAgent User Agent
 * @returns {Promise<Object>} 处理结果
 */
export async function uploadFile(file, options, res, ip, userAgent) {
  const {
    tags,
    category,
    purpose = 'general', // 'general', 'scratch', 'avatar'
    imageOptions = {}
  } = options;
  await assertUploadAllowed(res, purpose);

  // 如果文件对象包含检测到的类型信息，使用检测到的类型
  // 否则检测文件类型
  let detectedMimeType, detectedExtension;

  if (file.detectedMimeType && file.detectedExtension) {
    // 使用已检测的类型信息
    detectedMimeType = file.detectedMimeType;
    detectedExtension = file.detectedExtension;
  } else {
    // 重新检测文件类型
    const detection = await detectFileType(file.buffer);
    if (!detection.mimeType) {
      throw new Error("无法识别文件类型");
    }
    detectedMimeType = detection.mimeType;
    detectedExtension = detection.extension;
  }

  let processedBuffer = file.buffer;
  let finalExtension = detectedExtension;
  let finalMimeType = detectedMimeType;
  let metadata = {
    detectedType: {
      mimeType: detectedMimeType,
      extension: detectedExtension
    },
    frontendType: {
      mimeType: file.mimetype || 'unknown'
    },
    purpose: purpose
  };

  // 根据用途进行不同处理
  switch (purpose) {
    case 'scratch':
      // scratch 上传不做任何处理，保持原始文件
      logger.info("Scratch上传，保持原始文件");
      break;

    case 'avatar':
      // 头像处理：压缩为512x512，转换为webp，保持高质量
      if (detectedMimeType.startsWith('image/')) {
        try {
          const result = await processImage(file.buffer, {
            width: 512,
            height: 512,
            format: 'webp',
            quality: 95, // 保持原始质量
            sanitize: true,
            maxFileSize: 500 * 1024 // 500KB限制
          });

          processedBuffer = result.buffer;
          finalExtension = 'webp';
          finalMimeType = 'image/webp';
          metadata.imageProcessing = {
            originalFormat: detectedMimeType,
            processedFormat: 'webp',
            originalSize: file.buffer.length,
            processedSize: result.size,
            compressionRatio: result.compressionRatio,
            dimensions: {
              width: result.width,
              height: result.height
            }
          };
          logger.info("头像处理完成", metadata.imageProcessing);
        } catch (error) {
          logger.error("头像处理失败:", error);
          throw new Error(`头像处理失败: ${error.message}`);
        }
      } else {
        throw new Error("头像必须是图片格式");
      }
      break;

    case 'general':
    default:
      // 一般上传：图片转为webp，音频不处理
      if (detectedMimeType.startsWith('image/')) {
        try {
          const result = await processImage(file.buffer, {
            format: 'webp',
            quality: imageOptions.quality || 85,
            maxWidth: imageOptions.maxWidth,
            maxHeight: imageOptions.maxHeight,
            sanitize: true
          });

          processedBuffer = result.buffer;
          finalExtension = 'webp';
          finalMimeType = 'image/webp';
          metadata.imageProcessing = {
            originalFormat: detectedMimeType,
            processedFormat: 'webp',
            originalSize: file.buffer.length,
            processedSize: result.size,
            compressionRatio: result.compressionRatio,
            dimensions: {
              width: result.width,
              height: result.height
            }
          };
        } catch (error) {
          logger.warn("图片处理失败，使用原文件:", error);
          // 如果处理失败，使用原文件
        }
      } else if (detectedMimeType.startsWith('audio/')) {
        // 音频文件不做处理，保持原始格式
        logger.info("音频文件不做处理，保持原始格式");
        metadata.audioInfo = {
          originalFormat: detectedMimeType,
          size: file.buffer.length
        };
      }
      break;
  }

  // 生成MD5（基于处理后的最终文件）
  const md5 = generateMD5(processedBuffer);

  // 检查素材是否已存在
  const existingAsset = await visibleExistingAsset(await checkAssetExists(md5), res.locals.userid);
  if (existingAsset) {
    return {
      success: true,
      message: "素材已存在",
      asset: existingAsset,
      isExisting: true
    };
  }

  // 生成S3存储路径（使用处理后文件的MD5）
  const s3Key = `assets/${md5.substring(0, 2)}/${md5.substring(2, 4)}/${md5}.${finalExtension}`;

  // 上传到S3
  const s3Url = await uploadToS3(processedBuffer, s3Key, finalMimeType);

  // 创建数据库记录
  const assetData = {
    md5,
    filename: file.originalname,
    extension: finalExtension,
    mimeType: finalMimeType,
    fileSize: processedBuffer.length,
    uploaderId: res.locals.userid,
    uploaderIp: ip,
    uploaderUa: userAgent,
    metadata,
    tags: tags || '',
    category: category || (purpose === 'avatar' ? 'avatars' : 'general')
  };

  const asset = await createAssetRecord(assetData);

  return {
    success: true,
    message: "文件上传成功",
    asset: {
      ...asset,
      url: s3Url
    },
    isExisting: false,
    processing: metadata.imageProcessing || metadata.audioInfo || null
  };
}

/**
 * 向后兼容的文件上传函数（使用scratch模式）
 * @param {Object} file 上传的文件
 * @param {Object} options 处理选项
 * @param {Object} res Express响应对象
 * @param {string} ip IP地址
 * @param {string} userAgent User Agent
 * @returns {Promise<Object>} 处理结果
 */
export async function processFileUpload(file, options, res, ip, userAgent) {
  return uploadFile(file, { ...options, purpose: 'scratch' }, res, ip, userAgent);
}

/**
 * 通用的上传处理中间件逻辑
 * @param {Object} req Express请求对象
 * @param {Object} res Express响应对象
 * @param {Object} config 配置对象
 * @returns {Promise<Object>} 处理结果
 */
export async function handleAssetUpload(req, res, config = {}) {
  const {
    purpose = 'general',
    category = 'general',
    tags = '',
    requireFile = true,
    validateAuth = false,
    authCheck = null,
    imageOptions = {},
    successCallback = null,
    errorMessage = '文件上传失败'
  } = config;

  try {
    // 检查文件是否存在
    if (requireFile && !req.file) {
      return {
        success: false,
        status: 400,
        error: "没有上传文件"
      };
    }

    // 验证文件buffer
    if (req.file && (!Buffer.isBuffer(req.file.buffer) || req.file.buffer.length === 0)) {
      return {
        success: false,
        status: 400,
        error: req.file.buffer.length === 0 ? "文件为空" : "文件格式错误"
      };
    }

    // 权限验证
    if (validateAuth && authCheck) {
      const authResult = await authCheck(req, res);
      if (!authResult.success) {
        return {
          success: false,
          status: authResult.status || 403,
          error: authResult.error || "权限验证失败"
        };
      }
    }

    // 文件类型验证
    if (req.file) {
      const fileTypeValidation = await validateFileTypeFromContent(req.file.buffer, req.file.mimetype);

      if (!fileTypeValidation.isValid) {
        logger.warn("文件类型验证失败:", {
          originalname: req.file.originalname,
          frontendMimeType: req.file.mimetype,
          detectedMimeType: fileTypeValidation.mimeType,
          error: fileTypeValidation.error
        });
        return {
          success: false,
          status: 400,
          error: fileTypeValidation.error
        };
      }

      // 更新文件对象
      req.file.detectedMimeType = fileTypeValidation.mimeType;
      req.file.detectedExtension = fileTypeValidation.extension;
    }

    // 执行文件上传
    const uploadOptions = {
      purpose,
      category,
      tags,
      imageOptions
    };

    const result = await uploadFile(
      req.file,
      uploadOptions,
      res,
      req.ip,
      req.headers['user-agent']
    );

    if (!result.success) {
      return {
        success: false,
        status: 500,
        error: errorMessage
      };
    }

    // 执行成功回调
    if (successCallback) {
      const callbackResult = await successCallback(req, res, result);
      if (callbackResult) {
        Object.assign(result, callbackResult);
      }
    }

    return {
      success: true,
      result
    };

  } catch (error) {
    logger.error(`${errorMessage}:`, error);
    if (error.status) return { success: false, status: error.status, error: error.message, code: error.code };

    // 处理特定错误类型
    if (error.code === 'LIMIT_FILE_SIZE') {
      return {
        success: false,
        status: 413,
        error: "文件大小超过限制"
      };
    } else if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return {
        success: false,
        status: 400,
        error: "意外的文件字段"
      };
    } else if (error.message.includes('不支持的文件类型') || error.message.includes('不是有效的图片文件')) {
      return {
        success: false,
        status: 400,
        error: error.message
      };
    }

    return {
      success: false,
      status: 500,
      error: errorMessage,
      details: error.message
    };
  }
}