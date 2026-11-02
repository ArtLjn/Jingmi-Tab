-- 静谧新标签页备份库（MySQL 8.0+）
-- 在 jingmi_newtab 库内执行；应用账号只需要 SELECT/INSERT/UPDATE/DELETE。

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  rag_collection VARCHAR(80) NULL UNIQUE,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO users (id, username, created_at)
VALUES (1, 'local', UTC_TIMESTAMP(3));

CREATE TABLE IF NOT EXISTS sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL,
  last_used_at DATETIME(3) NULL,
  expires_at DATETIME(3) NOT NULL,
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS backups (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL DEFAULT 1,
  device_id VARCHAR(64) NOT NULL DEFAULT 'default',
  schema_version INT NOT NULL,
  client_version VARCHAR(32) NULL,
  payload LONGTEXT NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_backup_lookup (user_id, device_id, id),
  CONSTRAINT fk_backup_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 入库结果持久化，未知结果保持隔离，不因进程重启再次写入。
CREATE TABLE IF NOT EXISTS rag_writes (
  user_id BIGINT UNSIGNED NOT NULL,
  page_key CHAR(64) NOT NULL,
  payload_hash CHAR(64) NOT NULL DEFAULT '',
  doc_id VARCHAR(160) NOT NULL DEFAULT '',
  state VARCHAR(16) NOT NULL DEFAULT 'new',
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id, page_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rag_daily (
  user_id BIGINT UNSIGNED NOT NULL,
  usage_day DATE NOT NULL,
  writes INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
