account_id  = "15d29c8639fd3733b1b5486a2acfd968"
environment = "production"

domain_connect = {
  zone_id    = "ab14f406b3316dcfc3e2de7b379fffad"
  host       = "domainconnect.opensend.mx"
  key_id     = "_dck1"
  public_key = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnjQewwWQ0jSgWtbotOqgbSSy+TLFr8NVYAdmVG90AC19tEAKJCZmihzrnKppJcUlfXq5VIgeBoKRpTIvj3ibV7Gm3YGcC9NUme8BTbTsQEm12aAyzBVXGFdXLhh60d/9HB0jYTqQkdP/2y50IWTlGRePwXQ9Rz0zlXAKPma6Dpb66XVQkGOOKkFsJti9JcAb8BrcqQKd+bo1ngHbXrM270s/TAdfgwxswMLBYxxzPHW9DEbYuC3HojUfR+Ga1MH75Q+e2zEM6ENusM4EXUvpGSEWeA3KuI4VE4bci5TwQVzJK8PACjyIgKhzuM65nPgdzMrBSC7JqABEf7ViuId97wIDAQAB"
}

# Shared E2E test domain (OpenSend workspace of the E2E runner key; see api/README.md).
dns_records = [
  { zone_id = "ab14f406b3316dcfc3e2de7b379fffad", type = "CNAME", name = "dqhlelcigmxj6d5op3vfghe73vb6k5ya._domainkey.e2e.opensend.mx", content = "dqhlelcigmxj6d5op3vfghe73vb6k5ya.dkim.amazonses.com" },
  { zone_id = "ab14f406b3316dcfc3e2de7b379fffad", type = "CNAME", name = "mpn52n7d4jpa5maywkolkvql3r4gwvir._domainkey.e2e.opensend.mx", content = "mpn52n7d4jpa5maywkolkvql3r4gwvir.dkim.amazonses.com" },
  { zone_id = "ab14f406b3316dcfc3e2de7b379fffad", type = "CNAME", name = "a65huxiqe3fnztksugtxdofprx4kobg4._domainkey.e2e.opensend.mx", content = "a65huxiqe3fnztksugtxdofprx4kobg4.dkim.amazonses.com" },
  { zone_id = "ab14f406b3316dcfc3e2de7b379fffad", type = "TXT", name = "_opensend.e2e.opensend.mx", content = "40967c88-95de-499a-ae24-9fd5e7aad31b" },
  { zone_id = "ab14f406b3316dcfc3e2de7b379fffad", type = "MX", name = "e2e.opensend.mx", content = "inbound-smtp.us-east-2.amazonaws.com", priority = 10 },
]
