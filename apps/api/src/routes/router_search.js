import { Router } from "express";
import { prisma } from "../services/prisma.js"; // 功能函数集
import logger from "../services/logger.js";
import { visibleWhere, visibleSql, sanitizeProfiles } from "../services/moderation/visibility.js";

async function appendVisibility(conditions, params, kind, alias, viewerId) {
  const visibility = await visibleSql(kind, alias, viewerId);
  const offset = params.length;
  conditions.push(`(${visibility.text.replace(/\$(\d+)/g, (_, index) => `$${Number(index) + offset}`)})`);
  params.push(...visibility.values);
}
import { federatedUserSearch, parseFediAddress } from "../services/activitypub/index.js";

const router = Router();
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const FILE_SEARCH_PREFIX_LENGTH = 200000;
const TRGM_SEARCH_MIN_LENGTH = 2;

function toInt(value, defaultValue, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }
  return Math.min(max, Math.max(min, parsed));
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function parseStringList(raw) {
  if (!raw) {
    return [];
  }
  const sourceArray = Array.isArray(raw) ? raw : [raw];
  return sourceArray
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIdList(raw) {
  return parseStringList(raw)
    .map((id) => Number(id))
    .filter((id) => !Number.isNaN(id));
}

function parseTags(raw) {
  return parseStringList(raw);
}

function buildProjectStateFilter(useridArray, currentUserId, stateQuery) {
  const isCurrentUser =
    useridArray.length > 0 &&
    currentUserId &&
    useridArray.includes(Number(currentUserId));

  if (!stateQuery) {
    return isCurrentUser ? ["private", "public"] : ["public"];
  }
  if (stateQuery === "private") {
    return isCurrentUser ? ["private"] : ["public"];
  }
  return [stateQuery];
}

function buildListStateFilter(useridArray, currentUserId, stateQuery) {
  const isCurrentUser =
    useridArray.length > 0 &&
    currentUserId &&
    useridArray.includes(Number(currentUserId));

  if (!stateQuery) {
    return isCurrentUser ? ["private", "public"] : ["public"];
  }
  if (stateQuery === "private") {
    return isCurrentUser ? ["private"] : ["public"];
  }
  return [stateQuery];
}

function buildProjectOrder(orderbyQuery) {
  const [orderbyField, orderDirection] = String(orderbyQuery).split("_");
  const orderbyMap = {
    view: "view_count",
    time: "time",
    id: "id",
    star: "star_count",
  };
  const orderDirectionMap = { up: "asc", down: "desc" };
  const orderBy = orderbyMap[orderbyField] || "time";
  const order = orderDirectionMap[orderDirection] || "desc";
  return { orderBy, order };
}

function getOrderDirection(order) {
  return order === "asc" ? "ASC" : "DESC";
}

function buildInArrayFilter(valueArray, type = "text") {
  if (!valueArray || valueArray.length === 0) {
    return null;
  }
  return { value: valueArray, type };
}

function shouldUseTrgm(keyword) {
  return keyword && String(keyword).trim().length >= TRGM_SEARCH_MIN_LENGTH;
}

function escapeIlike(str) {
  return String(str).replace(/[%_\\]/g, "\\$&");
}

async function buildProjectTrgmWhere({ keyword, type, state, useridArray, tagsArray, viewerId }) {
  const ilikePattern = `%${escapeIlike(keyword)}%`;
  const params = [keyword, ilikePattern];
  const conditions = [
    "p.authorid IS NOT NULL",
    "p.type != 'readme'",
    `(COALESCE(p.name, '') % $1 OR COALESCE(p.title, '') % $1 OR COALESCE(p.description, '') % $1 OR p.name ILIKE $2 OR p.title ILIKE $2 OR p.description ILIKE $2)`,
  ];

  let paramIndex = 3;

  if (type) {
    conditions.push(`p.type = $${paramIndex}`);
    params.push(String(type));
    paramIndex += 1;
  }

  const stateFilter = buildInArrayFilter(state, "text");
  if (stateFilter) {
    conditions.push(`p.state = ANY($${paramIndex}::${stateFilter.type}[])`);
    params.push(stateFilter.value);
    paramIndex += 1;
  }

  const userFilter = buildInArrayFilter(useridArray, "int");
  if (userFilter) {
    conditions.push(`p.authorid = ANY($${paramIndex}::${userFilter.type}[])`);
    params.push(userFilter.value);
    paramIndex += 1;
  }

  const tagFilter = buildInArrayFilter(tagsArray, "text");
  if (tagFilter) {
    conditions.push(
      `EXISTS (SELECT 1 FROM ow_projects_tags t WHERE t.projectid = p.id AND t.name = ANY($${paramIndex}::${tagFilter.type}[]))`
    );
    params.push(tagFilter.value);
    paramIndex += 1;
  }

  conditions.push("(p.state = 'public' OR p.authorid = $" + (params.length + 1) + ")");
  params.push(Number(viewerId) || 0);
  await appendVisibility(conditions, params, "project", "p", viewerId);
  return {
    whereSql: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

async function findReadmeProjectUserIds(keyword, viewerId) {
  const projects = await prisma.ow_projects.findMany({
    where: { type: "readme", name: { contains: keyword, mode: "insensitive" }, AND: [await visibleWhere("project", viewerId)], OR: [{ state: "public" }, ...(viewerId ? [{ authorid: Number(viewerId) }] : [])] },
    select: { authorid: true },
    take: 20,
  });
  return [...new Set(projects.map((p) => p.authorid).filter(Boolean))];
}

async function searchProjectsByTrgm({
  keyword,
  type,
  state,
  useridArray,
  tagsArray,
  orderBy,
  order,
  skip,
  take,
  viewerId,
}) {
  const { whereSql, params } = await buildProjectTrgmWhere({
    keyword,
    type,
    state,
    useridArray,
    tagsArray,
    viewerId,
  });

  const scoreExpr =
    "GREATEST(similarity(COALESCE(p.name, ''), $1), similarity(COALESCE(p.title, ''), $1), similarity(COALESCE(p.description, ''), $1))";

  const dataSql = `
    SELECT p.id, ${scoreExpr} AS score
    FROM ow_projects p
    ${whereSql}
    ORDER BY score DESC, p.${orderBy} ${getOrderDirection(order)}
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM ow_projects p
    ${whereSql}
  `;

  const rows = await prisma.$queryRawUnsafe(dataSql, ...params, take, skip);
  const countRows = await prisma.$queryRawUnsafe(countSql, ...params);

  return {
    items: rows,
    total: countRows[0]?.total || 0,
  };
}

async function searchUsersByTrgm({ keyword, userStatus, skip, take, viewerId }) {
  const ilikePattern = `%${escapeIlike(keyword)}%`;
  const params = [keyword, ilikePattern];
  const conditions = [
    `(COALESCE(u.username, '') % $1 OR COALESCE(u.display_name, '') % $1 OR COALESCE(u.bio, '') % $1 OR COALESCE(u.location, '') % $1 OR COALESCE(u.region, '') % $1 OR u.username ILIKE $2 OR u.display_name ILIKE $2 OR u.bio ILIKE $2 OR u.location ILIKE $2 OR u.region ILIKE $2)`,
  ];
  let paramIndex = 3;

  if (userStatus) {
    conditions.push(`u.status = $${paramIndex}`);
    params.push(String(userStatus));
    paramIndex += 1;
  }

  await appendVisibility(conditions, params, "profile", "u", viewerId);
  const scoreExpr =
    "GREATEST(similarity(COALESCE(u.username, ''), $1), similarity(COALESCE(u.display_name, ''), $1), similarity(COALESCE(u.bio, ''), $1), similarity(COALESCE(u.location, ''), $1), similarity(COALESCE(u.region, ''), $1))";

  const whereSql = `WHERE ${conditions.join(" AND ")}`;

  const dataSql = `
    SELECT u.id, ${scoreExpr} AS score
    FROM ow_users u
    ${whereSql}
    ORDER BY score DESC, u."regTime" DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM ow_users u
    ${whereSql}
  `;

  const rows = await prisma.$queryRawUnsafe(dataSql, ...params, take, skip);
  const countRows = await prisma.$queryRawUnsafe(countSql, ...params);

  return {
    items: rows,
    total: countRows[0]?.total || 0,
  };
}

async function searchPostsByTrgm({ keyword, postType, useridArray, skip, take, viewerId }) {
  const ilikePattern = `%${escapeIlike(keyword)}%`;
  const params = [keyword, ilikePattern];
  const conditions = [
    "p.is_deleted = false",
    "(COALESCE(p.content, '') % $1 OR p.content ILIKE $2)",
  ];
  let paramIndex = 3;

  if (postType) {
    conditions.push(`p.post_type = $${paramIndex}`);
    params.push(String(postType));
    paramIndex += 1;
  }

  const authorFilter = buildInArrayFilter(useridArray, "int");
  if (authorFilter) {
    conditions.push(`p.author_id = ANY($${paramIndex}::${authorFilter.type}[])`);
    params.push(authorFilter.value);
    paramIndex += 1;
  }

  await appendVisibility(conditions, params, "post", "p", viewerId);
  const scoreExpr = "similarity(COALESCE(p.content, ''), $1)";
  const whereSql = `WHERE ${conditions.join(" AND ")}`;

  const dataSql = `
    SELECT p.id, ${scoreExpr} AS score
    FROM ow_posts p
    ${whereSql}
    ORDER BY score DESC, p.created_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM ow_posts p
    ${whereSql}
  `;

  const rows = await prisma.$queryRawUnsafe(dataSql, ...params, take, skip);
  const countRows = await prisma.$queryRawUnsafe(countSql, ...params);

  return {
    items: rows,
    total: countRows[0]?.total || 0,
  };
}

async function searchProjectFiles({
  keyword,
  useridArray,
  currentUserId,
  skip,
  limit,
}) {
  const q = String(keyword || "").trim();
  if (!q || !currentUserId) {
    return { items: [], total: 0, strategy: "disabled" };
  }

  // 项目文件可能包含私有源码，搜索限定为当前用户自己的文件
  const allowedOwners = [Number(currentUserId)];
  const requestedOwners = useridArray.length > 0 ? useridArray : allowedOwners;
  const ownerFilter = requestedOwners.filter((id) => allowedOwners.includes(id));
  if (ownerFilter.length === 0) {
    return { items: [], total: 0, strategy: "owner_filtered" };
  }

  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT
      sha256,
      create_userid,
      create_time,
      ts_rank_cd(
        COALESCE(search_vector, to_tsvector('simple', left(COALESCE(source, ''), $1))),
        websearch_to_tsquery('simple', $2)
      ) AS score,
      COALESCE(search_preview, left(COALESCE(source, ''), 240)) AS preview
    FROM ow_projects_file
    WHERE create_userid = ANY($3::int[])
      AND ((storage_provider = 's3' AND search_vector @@ websearch_to_tsquery('simple', $2))
        OR (storage_provider IS DISTINCT FROM 's3'
          AND to_tsvector('simple', left(COALESCE(source, ''), $1)) @@ websearch_to_tsquery('simple', $2)))
    ORDER BY score DESC, create_time DESC NULLS LAST
    LIMIT $4 OFFSET $5
    `,
    FILE_SEARCH_PREFIX_LENGTH,
    q,
    ownerFilter,
    limit,
    skip
  );

  const countRows = await prisma.$queryRawUnsafe(
    `
    SELECT COUNT(*)::int AS total
    FROM ow_projects_file
    WHERE create_userid = ANY($2::int[])
      AND ((storage_provider = 's3' AND search_vector @@ websearch_to_tsquery('simple', $3))
        OR (storage_provider IS DISTINCT FROM 's3'
          AND to_tsvector('simple', left(COALESCE(source, ''), $1)) @@ websearch_to_tsquery('simple', $3)))
    `,
    FILE_SEARCH_PREFIX_LENGTH,
    ownerFilter,
    q
  );

  return {
    items: rows,
    total: countRows[0]?.total || 0,
    strategy: "fulltext",
  };
}

/**
 * @api {get} /searchapi/ Unified Search
 * @apiName UnifiedSearch
 * @apiGroup Search
 *
 * @apiDescription 统一搜索接口，支持项目、用户、帖子、列表、标签、项目文件查询。
 *
 * @apiQuery {String} [keyword] 通用关键字（推荐，兼容 `q`）
 * @apiQuery {String="projects","users","posts","project_files","lists","tags"} [scope=projects] 搜索范围（兼容 `search_scope`）
 * @apiQuery {String|String[]} [userId] 用户ID（支持 `1,2,3` 或重复传参，兼容 `search_userid`）
 * @apiQuery {String|String[]} [tags] 标签过滤（支持 `a,b` 或重复传参，兼容 `search_tag`）
 * @apiQuery {String} [orderBy=time_down] 项目排序（兼容 `search_orderby`）
 * @apiQuery {Number} [page=1] 页码（兼容 `curr`）
 * @apiQuery {Number} [perPage=10] 每页数量（最大50，兼容 `limit`）
 * @apiQuery {String} [search_userid] 用户ID列表，逗号分隔
 * @apiQuery {String} [search_type] 项目类型过滤
 * @apiQuery {String} [search_orderby=time_down] 项目排序: view_up/down, time_up/down, id_up/down, star_up/down
 * @apiQuery {String} [search_tag] 项目标签过滤，逗号分隔
 * @apiQuery {String} [search_state] 项目/列表状态过滤
 * @apiQuery {String} [search_post_type] 帖子类型过滤
 * @apiQuery {String} [search_user_status] 用户状态过滤
 * @apiQuery {Number} [curr=1] 页码（1开始）
 * @apiQuery {Number} [limit=10] 每页数量（最大50）
 *
 * @apiSuccess {String} scope 实际生效的搜索范围
 * @apiSuccess {String} query 实际搜索关键字
 * @apiSuccess {Number} page 当前页
 * @apiSuccess {Number} limit 每页数量
 * @apiSuccess {Object[]} projects 项目结果
 * @apiSuccess {Object[]} users 用户结果
 * @apiSuccess {Object[]} posts 帖子结果
 * @apiSuccess {Object[]} projectFiles 项目文件结果
 * @apiSuccess {Object[]} lists 列表结果
 * @apiSuccess {Object[]} tags 标签结果（来自 `ow_projects_tags` 关联表）
 * @apiSuccess {Object} totals 各类型总数
 * @apiSuccess {Number} totalCount 当前 scope 总数
 * @apiSuccess {String} fileSearchStrategy 项目文件搜索策略
 */
// 搜索：Scratch项目列表：数据（直接查询表）
router.get("/", async (req, res, next) => {
  try {
    const keywordInput = pickFirst(req.query.keyword, req.query.q, "");
    const scopeRaw = pickFirst(req.query.scope, req.query.search_scope, "projects");
    const userid = pickFirst(
      req.query.userId,
      req.query.userid,
      req.query.authorid,
      req.query.search_userid
    );
    const type = pickFirst(req.query.type, req.query.search_type);
    const orderbyQuery = pickFirst(
      req.query.orderBy,
      req.query.orderby,
      req.query.sort,
      req.query.search_orderby,
      "time_down"
    );
    const tags = pickFirst(req.query.tags, req.query.tag, req.query.search_tag, "");
    const curr = pickFirst(req.query.page, req.query.curr, 1);
    const limit = pickFirst(req.query.perPage, req.query.pageSize, req.query.limit, DEFAULT_LIMIT);
    const stateQuery = pickFirst(req.query.state, req.query.search_state, "");
    const postType = pickFirst(req.query.postType, req.query.search_post_type);
    const userStatus = pickFirst(req.query.userStatus, req.query.search_user_status);

    const scope = String(scopeRaw || "projects").toLowerCase();
    const validScopes = new Set([
      "projects",
      "users",
      "posts",
      "project_files",
      "lists",
      "tags",
      "list",
      "tag",
    ]);
    const finalScope = validScopes.has(scope) ? scope : "projects";
    const normalizedScope =
      finalScope === "list" ? "lists" : finalScope === "tag" ? "tags" : finalScope;

    const page = toInt(curr, 1, 1);
    const take = toInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const skip = (page - 1) * take;
    const keyword = String(keywordInput || "").trim();
    const useTrgm = shouldUseTrgm(keyword);

    const useridArray = parseIdList(userid);
    const tagsArray = parseTags(tags);
    const state = buildProjectStateFilter(useridArray, res.locals.userid, stateQuery);
    const listState = buildListStateFilter(useridArray, res.locals.userid, stateQuery);
    const { orderBy, order } = buildProjectOrder(orderbyQuery);

    const viewerId = res.locals.userid || null;
    const projectVisibility = ["projects", "tags"].includes(normalizedScope) ? await visibleWhere("project", viewerId) : {};
    const userVisibility = normalizedScope === "users" ? await visibleWhere("profile", viewerId) : {};
    const postVisibility = normalizedScope === "posts" ? await visibleWhere("post", viewerId) : {};
    const listVisibility = normalizedScope === "lists" ? await visibleWhere("list", viewerId) : {};
    const projectAnd = [
      projectVisibility,
      { OR: [{ state: "public" }, ...(viewerId ? [{ authorid: Number(viewerId) }] : [])] },
      { authorid: { not: null } },
      { type: { not: "readme" } },
      type ? { type: { equals: String(type) } } : undefined,
      state.length > 0 ? { state: { in: state } } : undefined,
      useridArray.length > 0 ? { authorid: { in: useridArray } } : undefined,
      tagsArray.length > 0 ? { project_tags: { some: { name: { in: tagsArray } } } } : undefined,
      keyword
        ? {
            OR: [
              { name: { contains: keyword, mode: "insensitive" } },
              { title: { contains: keyword, mode: "insensitive" } },
              { description: { contains: keyword, mode: "insensitive" } },
              { project_tags: { some: { name: { contains: keyword, mode: "insensitive" } } } },
            ],
          }
        : undefined,
    ].filter(Boolean);
    const projectWhere = projectAnd.length > 0 ? { AND: projectAnd } : {};

    const userAnd = [
      userVisibility,
      userStatus ? { status: { equals: String(userStatus) } } : undefined,
      keyword
        ? {
            OR: [
              { username: { contains: keyword, mode: "insensitive" } },
              { display_name: { contains: keyword, mode: "insensitive" } },
              { email: { contains: keyword, mode: "insensitive" } },
              { bio: { contains: keyword, mode: "insensitive" } },
              { location: { contains: keyword, mode: "insensitive" } },
              { region: { contains: keyword, mode: "insensitive" } },
            ],
          }
        : undefined,
    ].filter(Boolean);
    const userWhere = userAnd.length > 0 ? { AND: userAnd } : {};

    const postAnd = [
      postVisibility,
      { is_deleted: false },
      postType ? { post_type: { equals: String(postType) } } : undefined,
      useridArray.length > 0 ? { author_id: { in: useridArray } } : undefined,
      keyword ? { content: { contains: String(keyword), mode: "insensitive" } } : undefined,
    ].filter(Boolean);
    const postWhere = postAnd.length > 0 ? { AND: postAnd } : {};

    const listAnd = [
      listVisibility,
      { OR: [{ state: "public" }, ...(viewerId ? [{ authorid: Number(viewerId) }] : [])] },
      listState.length > 0 ? { state: { in: listState } } : undefined,
      useridArray.length > 0 ? { authorid: { in: useridArray } } : undefined,
      keyword
        ? {
            OR: [
              { title: { contains: keyword, mode: "insensitive" } },
              { description: { contains: keyword, mode: "insensitive" } },
            ],
          }
        : undefined,
    ].filter(Boolean);
    const listWhere = listAnd.length > 0 ? { AND: listAnd } : {};

    const tagWhere = {
      name: {
        not: "",
        ...(keyword ? { contains: keyword, mode: "insensitive" } : {}),
      },
      project: {
        AND: [projectVisibility],
        OR: [{ state: "public" }, ...(viewerId ? [{ authorid: Number(viewerId) }] : [])],
        ...(type ? { type: { equals: String(type) } } : {}),
        ...(useridArray.length > 0 ? { authorid: { in: useridArray } } : {}),
        state: { in: state },
      },
    };

    let projects = [];
    let users = [];
    let posts = [];
    let projectFiles = [];
    let lists = [];
    let tagItems = [];
    let projectTotal = 0;
    let userTotal = 0;
    let postTotal = 0;
    let projectFileTotal = 0;
    let listTotal = 0;
    let tagTotal = 0;
    let fileSearchStrategy = "disabled";

    if (normalizedScope === "projects") {
      if (keyword && useTrgm) {
        const projectResult = await searchProjectsByTrgm({
          keyword,
          type,
          state,
          useridArray,
          tagsArray,
          orderBy,
          order,
          skip,
          take,
          viewerId,
        });
        projectTotal = projectResult.total;
        const projectIds = projectResult.items.map((item) => item.id);
        if (projectIds.length > 0) {
          const projectRows = await prisma.ow_projects.findMany({
            where: { id: { in: projectIds }, AND: [projectVisibility], OR: [{ state: "public" }, ...(viewerId ? [{ authorid: Number(viewerId) }] : [])] },
            select: {
              id: true,
              title: true,
              description: true,
              view_count: true,
              thumbnail: true,
              star_count: true,
              time: true,
              state: true,
              name: true,
              author: {
                select: {
                  display_name: true,
                  id: true,
                  avatar: true,
                  username: true,
                },
              },
            },
          });
          const projectMap = new Map(projectRows.map((row) => [row.id, row]));
          projects = projectIds.map((id) => projectMap.get(id)).filter(Boolean);
        }
      } else {
      [projectTotal, projects] = await Promise.all([
        prisma.ow_projects.count({ where: projectWhere }),
        prisma.ow_projects.findMany({
          where: projectWhere,
          orderBy: { [orderBy]: order },
          select: {
            id: true,
            title: true,
            description: true,
            view_count: true,
            thumbnail: true,
            star_count: true,
            time: true,
            state: true,
            name: true,
            author: {
              select: {
                display_name: true,
                id: true,
                avatar: true,
                username: true,
              },
            },
          },
          skip,
          take,
        }),
      ]);
      }
    }

    if (normalizedScope === "users") {
      // 检查是否为联邦地址格式 (@user@domain 或 user@domain)
      const fediAddr = keyword ? parseFediAddress(keyword) : null;

      if (fediAddr) {
        // 联邦用户搜索：同时搜索本地和远端
        try {
          const fediResult = await federatedUserSearch(keyword, {
            limit: take,
            currentUserId: res.locals.userid || null,
          });
          users = fediResult.users || [];
          // 如果通过 WebFinger 解析到了远程用户，追加到结果中（如果不在本地结果里）
          if (fediResult.remoteUser) {
            const existingIds = new Set(users.map(u => u.id));
            if (!existingIds.has(fediResult.remoteUser.id)) {
              users.unshift({
                ...fediResult.remoteUser,
                is_remote: true,
              });
            }
          }
          userTotal = users.length;
        } catch (fediErr) {
          logger.warn('[search] 联邦用户搜索失败，回退到本地搜索:', fediErr.message);
          // 回退到普通搜索
          if (keyword && useTrgm) {
            const userResult = await searchUsersByTrgm({ keyword, userStatus, skip, take, viewerId });
            userTotal = userResult.total;
            const userIds = userResult.items.map((item) => item.id);
            if (userIds.length > 0) {
              const userRows = await prisma.ow_users.findMany({
                where: { id: { in: userIds }, AND: [userVisibility] },
                select: {
                  id: true, username: true, display_name: true, avatar: true,
                  status: true, bio: true, location: true, region: true, regTime: true,
                },
              });
              const userMap = new Map(userRows.map((row) => [row.id, row]));
              users = userIds.map((id) => userMap.get(id)).filter(Boolean);
            }
          } else {
            [userTotal, users] = await Promise.all([
              prisma.ow_users.count({ where: userWhere }),
              prisma.ow_users.findMany({
                where: userWhere, orderBy: { regTime: "desc" },
                select: {
                  id: true, username: true, display_name: true, avatar: true,
                  status: true, bio: true, location: true, region: true, regTime: true,
                },
                skip, take,
              }),
            ]);
          }
        }
      } else if (keyword && useTrgm) {
        const userResult = await searchUsersByTrgm({
          keyword,
          userStatus,
          skip,
          take,
          viewerId,
        });
        userTotal = userResult.total;
        const userIds = userResult.items.map((item) => item.id);
        if (userIds.length > 0) {
          const userRows = await prisma.ow_users.findMany({
            where: { id: { in: userIds }, AND: [userVisibility] },
            select: {
              id: true,
              username: true,
              display_name: true,
              avatar: true,
              status: true,
              bio: true,
              location: true,
              region: true,
              regTime: true,
            },
          });
          const userMap = new Map(userRows.map((row) => [row.id, row]));
          users = userIds.map((id) => userMap.get(id)).filter(Boolean);
        }
      } else {
        [userTotal, users] = await Promise.all([
          prisma.ow_users.count({ where: userWhere }),
          prisma.ow_users.findMany({
            where: userWhere,
            orderBy: { regTime: "desc" },
            select: {
              id: true,
              username: true,
              display_name: true,
              avatar: true,
              status: true,
              bio: true,
              location: true,
              region: true,
              regTime: true,
            },
            skip,
            take,
          }),
        ]);
      }

      // 将 readme 项目匹配的用户追加到搜索结果
      if (keyword) {
        const readmeUserIds = await findReadmeProjectUserIds(keyword, viewerId);
        if (readmeUserIds.length > 0) {
          const existingIds = new Set(users.map((u) => u.id));
          const newIds = readmeUserIds.filter((id) => !existingIds.has(id));
          if (newIds.length > 0) {
            const extraUsers = await prisma.ow_users.findMany({
              where: { id: { in: newIds }, AND: [userVisibility] },
              select: {
                id: true, username: true, display_name: true, avatar: true,
                status: true, bio: true, location: true, region: true, regTime: true,
              },
            });
            users.push(...extraUsers);
          }
        }
      }
    }

    if (normalizedScope === "posts") {
      if (keyword && useTrgm) {
        const postResult = await searchPostsByTrgm({
          keyword,
          postType,
          useridArray,
          skip,
          take,
          viewerId,
        });
        postTotal = postResult.total;
        const postIds = postResult.items.map((item) => item.id);
        if (postIds.length > 0) {
          const postRows = await prisma.ow_posts.findMany({
            where: { id: { in: postIds }, AND: [postVisibility] },
            select: {
              id: true,
              author_id: true,
              post_type: true,
              content: true,
              character_count: true,
              reply_count: true,
              retweet_count: true,
              like_count: true,
              bookmark_count: true,
              created_at: true,
              updated_at: true,
              author: {
                select: {
                  id: true,
                  username: true,
                  display_name: true,
                  avatar: true,
                },
              },
            },
          });
          const postMap = new Map(postRows.map((row) => [row.id, row]));
          posts = postIds.map((id) => postMap.get(id)).filter(Boolean);
        }
      } else {
        [postTotal, posts] = await Promise.all([
          prisma.ow_posts.count({ where: postWhere }),
          prisma.ow_posts.findMany({
            where: postWhere,
            orderBy: { created_at: "desc" },
            select: {
              id: true,
              author_id: true,
              post_type: true,
              content: true,
              character_count: true,
              reply_count: true,
              retweet_count: true,
              like_count: true,
              bookmark_count: true,
              created_at: true,
              updated_at: true,
              author: {
                select: {
                  id: true,
                  username: true,
                  display_name: true,
                  avatar: true,
                },
              },
            },
            skip,
            take,
          }),
        ]);
      }
    }

    if (normalizedScope === "project_files") {
      const fileResult = await searchProjectFiles({
        keyword,
        useridArray,
        currentUserId: res.locals.userid,
        skip,
        limit: take,
      });
      projectFiles = fileResult.items;
      projectFileTotal = fileResult.total;
      fileSearchStrategy = fileResult.strategy;
    }

    if (normalizedScope === "lists") {
      [listTotal, lists] = await Promise.all([
        prisma.ow_projects_lists.count({ where: listWhere }),
        prisma.ow_projects_lists.findMany({
          where: listWhere,
          orderBy: { updateTime: "desc" },
          select: {
            id: true,
            title: true,
            description: true,
            state: true,
            updateTime: true,
            createTime: true,
            author: {
              select: {
                id: true,
                username: true,
                display_name: true,
                avatar: true,
              },
            },
          },
          skip,
          take,
        }),
      ]);
    }

    if (normalizedScope === "tags") {
      const [groupedTags, countedTags] = await Promise.all([
        prisma.ow_projects_tags.groupBy({
          by: ["name"],
          where: tagWhere,
          _count: { name: true },
          orderBy: [{ _count: { name: "desc" } }, { name: "asc" }],
          skip,
          take,
        }),
        prisma.ow_projects_tags.groupBy({
          by: ["name"],
          where: tagWhere,
        }),
      ]);

      tagItems = groupedTags.map((tag) => ({
        name: tag.name,
        count: tag._count.name,
      }));
      tagTotal = countedTags.length;
    }

    const authoredItems = [...projects, ...posts, ...lists];
    const profiles = await sanitizeProfiles([...users, ...authoredItems.map(item => item.author)], viewerId);
    authoredItems.forEach((item, index) => { item.author = profiles[users.length + index]; });
    users = profiles.slice(0, users.length).filter(Boolean);
    const totals = {
      projects: projectTotal,
      users: userTotal,
      posts: postTotal,
      projectFiles: projectFileTotal,
      lists: listTotal,
      tags: tagTotal,
    };

    const scopeTotalMap = {
      projects: projectTotal,
      users: userTotal,
      posts: postTotal,
      project_files: projectFileTotal,
      lists: listTotal,
      tags: tagTotal,
    };

    // 兼容旧版返回结构（默认项目搜索）
    if (normalizedScope === "projects" && !keyword) {
      return res.status(200).send({
        projects,
        totalCount: projectTotal,
      });
    }

    return res.status(200).send({
      scope: normalizedScope,
      query: keyword,
      page,
      limit: take,
      projects,
      users,
      posts,
      projectFiles,
      lists,
      tags: tagItems,
      totals,
      totalCount: scopeTotalMap[normalizedScope],
      fileSearchStrategy,
    });
  } catch (error) {
    logger.error("search api error:", error);
    next(error);
  }
});

export default router;
