# Security policy

ZanaLLaima is experimental, local-only orchestration software. It is not approved for production or remote exposure. The local MCP server uses stdio only.

## Reporting vulnerabilities

Avoid publishing exploit details, private credentials, signing keys, or sensitive logs in public issues. Contact the repository owner privately using an established channel, or use GitHub private vulnerability reporting if the repository supports it.

## Security boundaries

A mission request does not grant write permission. Only operator-signed, scoped and unexpired permissions can authorize local controller operations. External tools and host execution environments are **not yet proven to enforce these permissions** at the actual filesystem or repository mutation boundary. Do not place operator private signing keys in model-visible environment variables, repository files, or MCP arguments.

Never expose the local MCP server directly to the internet. Remote authentication, transport protections, user isolation and resource quotas are not implemented. CI success is not an independent security review and cannot authorize merge or deployment.

See [release security and open blockers](docs/release-security.md), [write authorization](docs/safety-lifecycle.md) and [Git-bound review](docs/solo-rdd.md).
