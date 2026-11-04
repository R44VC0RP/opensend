# OpenSend MX account resources on the Anomaly Cloudflare account: queues, the attachment
# bucket and the Hyperdrive connection. The Worker itself (routes, Durable Objects, rate
# limiter, vars) is deployed by wrangler from api/wrangler.<environment>.jsonc, which binds
# these resources by name and ID.
#
#   cd infra
#   tofu init -backend-config="key=<environment>/terraform.tfstate"
#   tofu apply -var-file=<environment>.tfvars
#
# Credentials come from the environment, never from files in this directory:
# CLOUDFLARE_API_TOKEN for the provider, AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for the
# R2 state bucket, TF_VAR_state_passphrase for state encryption, and TF_VAR_database once
# the environment's Postgres exists.

terraform {
  required_version = ">= 1.10"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.28" }
  }
  # State lives in R2 (bucket created once with `cf r2 buckets create opensend-tofu-state`).
  backend "s3" {
    bucket                      = "opensend-tofu-state"
    region                      = "auto"
    endpoints                   = { s3 = "https://15d29c8639fd3733b1b5486a2acfd968.r2.cloudflarestorage.com" }
    use_path_style              = true
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
  # State holds the Hyperdrive database password, so it is encrypted before it reaches R2.
  # The passphrase is TF_VAR_state_passphrase (GitHub mx environment); losing it means
  # re-importing the resources into a new state.
  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method = method.aes_gcm.state
    }
    plan {
      method = method.aes_gcm.state
    }
  }
}

variable "state_passphrase" {
  type      = string
  sensitive = true
}

variable "account_id" {
  type = string
}

variable "environment" {
  type        = string
  description = "Resource name suffix, e.g. production."
}

variable "origin_connection_limit" {
  type    = number
  default = 30
}

variable "bucket_location" {
  type    = string
  default = "enam"
}

variable "database" {
  description = "Postgres origin for Hyperdrive. Leave unset until the database exists."
  type = object({
    host     = string
    port     = optional(number, 5432)
    name     = string
    user     = string
    password = string
  })
  default   = null
  sensitive = true
}

locals {
  prefix = "opensend-mx-${var.environment}"
}

resource "cloudflare_queue" "work" {
  account_id = var.account_id
  queue_name = "${local.prefix}-work"
}

# Verified SES feedback and simulated callbacks; the Worker matches it by FEEDBACK_QUEUE_NAME.
resource "cloudflare_queue" "feedback" {
  account_id = var.account_id
  queue_name = "${local.prefix}-feedback"
}

resource "cloudflare_r2_bucket" "attachments" {
  account_id = var.account_id
  name       = "${local.prefix}-attachments"
  location   = var.bucket_location
}

resource "cloudflare_hyperdrive_config" "db" {
  count      = var.database == null ? 0 : 1
  account_id = var.account_id
  name       = local.prefix
  origin = {
    scheme   = "postgres"
    host     = var.database.host
    port     = var.database.port
    database = var.database.name
    user     = var.database.user
    password = var.database.password
  }
  # Query caching would serve stale rows to the API; production runs with it disabled too.
  caching = { disabled = true }
  # Leave database connections free for migrations and operators: PlanetScale PS-20 has far fewer
  # than Hyperdrive's default 60, and the first deploy that filled them failed with 53300.
  origin_connection_limit = var.origin_connection_limit
}

output "work_queue" {
  value = cloudflare_queue.work.queue_name
}

output "feedback_queue" {
  value = cloudflare_queue.feedback.queue_name
}

output "attachments_bucket" {
  value = cloudflare_r2_bucket.attachments.name
}

output "hyperdrive_id" {
  value = one(cloudflare_hyperdrive_config.db[*].id)
}
