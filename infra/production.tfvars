account_id  = "15d29c8639fd3733b1b5486a2acfd968"
environment = "production"
zone_id     = "ab14f406b3316dcfc3e2de7b379fffad"
# Shared inbound domain (in.opensend.mx, us-east-2), from provider_pool_regions.inbound_dns.
dns_records = [
  { type = "MX", name = "*.in.opensend.mx", content = "inbound-smtp.us-east-2.amazonaws.com", priority = 10 },
  { type = "CNAME", name = "o2grtpefn3dt4rcpmucpxvnh3h647owg._domainkey.in.opensend.mx", content = "o2grtpefn3dt4rcpmucpxvnh3h647owg.dkim.amazonses.com" },
  { type = "CNAME", name = "4c3ejgdr7vitfvox6wurtfjzoixmchly._domainkey.in.opensend.mx", content = "4c3ejgdr7vitfvox6wurtfjzoixmchly.dkim.amazonses.com" },
  { type = "CNAME", name = "ee6vxg5eac5ydq4q6qkygs5gmztozbxm._domainkey.in.opensend.mx", content = "ee6vxg5eac5ydq4q6qkygs5gmztozbxm.dkim.amazonses.com" },
]
