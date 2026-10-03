/** Generated from pinned codebase-memory-mcp v0.9.0 tools/list (all pages). Verify against the binary when the pin changes. */
export const CODEBASE_MEMORY_TOOLS = [
  {
    "name": "index_repository",
    "title": "Index repository",
    "description": "Index a repository into the knowledge graph. Special mode 'cross-repo-intelligence': skip extraction, only match Routes/Channels across projects to create CROSS_HTTP_CALLS/CROSS_ASYNC_CALLS/CROSS_CHANNEL edges. Requires target_projects param. Ensure target projects have fresh indexes first.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "repo_path": {
          "type": "string",
          "description": "Path to the repository"
        },
        "mode": {
          "type": "string",
          "enum": [
            "full",
            "moderate",
            "fast",
            "cross-repo-intelligence"
          ],
          "default": "full",
          "description": "All modes run type-aware LSP call/usage resolution (per-file + cross-file). full: all files + similarity/semantic edges. moderate: filtered files + similarity/semantic. fast: filtered files, no similarity/semantic. cross-repo-intelligence: match Routes/Channels across projects."
        },
        "target_projects": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Projects to search for cross-repo links (cross-repo-intelligence mode). Use [\"*\"] for all indexed projects. Run list_projects to see available projects."
        },
        "name": {
          "type": "string",
          "description": "Override the derived project name. Non-ASCII bytes are encoded and unsafe path characters are normalized."
        },
        "persistence": {
          "type": "boolean",
          "default": false,
          "description": "Write compressed artifact to .codebase-memory/graph.db.zst for team sharing. Teammates can bootstrap from the artifact instead of full re-indexing."
        }
      },
      "required": [
        "repo_path"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "search_graph",
    "title": "Search graph",
    "description": "Search the code knowledge graph for functions, classes, routes, and variables. Use INSTEAD OF grep/glob when finding code definitions, implementations, or relationships. Three search modes: (1) query='update settings' for BM25 ranked full-text search with camelCase splitting and structural label boosting — recommended for natural-language discovery; (2) name_pattern='.*regex.*' for exact pattern matching; (3) semantic_query=[...] for vector cosine search that bridges vocabulary (finds 'publish' when you search 'send'). The three modes are independent and can be combined in a single call. PAGINATION: results are capped at limit (default 200) — broader queries are silently truncated. The response always includes 'total' (full match count before limit) and 'has_more' (true when total > offset+returned). Detect truncation with has_more, then page by re-calling with offset=offset+limit until has_more is false. Narrow first via label/file_pattern/min_degree before paginating large result sets.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string"
        },
        "query": {
          "type": "string",
          "description": "Natural-language or keyword full-text search using BM25 ranking. Tokens are split on whitespace; camelCase identifiers are indexed as individual words (updateCloudClient → update, cloud, client). Results are ranked with structural boosting: Functions/Methods +10, Routes +8, Classes/Interfaces +5. Noise labels (File/Folder/Module/Variable) are filtered out. When provided, name_pattern is ignored."
        },
        "label": {
          "type": "string"
        },
        "name_pattern": {
          "type": "string"
        },
        "qn_pattern": {
          "type": "string"
        },
        "file_pattern": {
          "type": "string"
        },
        "relationship": {
          "type": "string"
        },
        "min_degree": {
          "type": "integer"
        },
        "max_degree": {
          "type": "integer"
        },
        "exclude_entry_points": {
          "type": "boolean"
        },
        "include_connected": {
          "type": "boolean"
        },
        "semantic_query": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "MUST be an ARRAY of keyword strings (e.g. [\"send\",\"pubsub\",\"publish\"]) — NOT a single string. Each keyword is scored independently via per-keyword min-cosine; results reflect functions that score well on ALL keywords. Requires moderate/full index mode. Results appear in the 'semantic_results' field (separate from 'results')."
        },
        "limit": {
          "type": "integer",
          "description": "Max results per call. Default 200. Response carries 'total' (full match count) and 'has_more' (true if truncated) so callers can detect the limit and paginate."
        },
        "offset": {
          "type": "integer",
          "default": 0,
          "description": "Skip the first N matching nodes. Combine with 'limit' to page: increment offset by limit and re-call while has_more is true."
        }
      },
      "required": [
        "project"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "query_graph",
    "title": "Query graph",
    "description": "Execute a Cypher query against the knowledge graph for complex multi-hop patterns, aggregations, and cross-service analysis. The response includes 'total' (returned row count). There is a hard 100k row ceiling — for broad queries add LIMIT in the Cypher itself or use search_graph + offset/limit pagination instead. COMPLEXITY / BOTTLENECKS: every Function and Method node carries queryable complexity properties — cyclomatic (complexity), cognitive, loop_count, loop_depth (max nested-loop depth, a polynomial-degree proxy), plus interprocedural transitive_loop_depth (worst-case nested-loop degree propagated along CALLS edges) and a recursive flag. Additional hot-path signals: linear_scan_in_loop (count of find/contains/indexOf-style scans inside a loop — the hidden O(n^2) that loop_depth misses), alloc_in_loop (allocations/appends inside a loop), recursion_in_loop (a self-call inside a loop), unguarded_recursion (recursion with no conditionally-guarded base case), param_count and max_access_depth (structure smells). Find all hot-path candidates in one query, e.g. MATCH (f:Function) WHERE f.transitive_loop_depth >= 3 OR f.linear_scan_in_loop >= 1 RETURN f.qualified_name, f.transitive_loop_depth, f.linear_scan_in_loop ORDER BY f.transitive_loop_depth DESC.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Cypher query"
        },
        "project": {
          "type": "string"
        },
        "max_rows": {
          "type": "integer",
          "description": "Optional row limit. Default: unlimited up to a 100k row ceiling. No offset support — use search_graph for paginated browsing."
        }
      },
      "required": [
        "query",
        "project"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "trace_path",
    "title": "Trace path",
    "description": "Trace paths through the code graph. Modes: calls (callers/callees), data_flow (value propagation with args at each hop), cross_service (through HTTP/async Route nodes). Use INSTEAD OF grep for callers, dependencies, impact analysis, or data flow tracing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "function_name": {
          "type": "string"
        },
        "project": {
          "type": "string"
        },
        "direction": {
          "type": "string",
          "enum": [
            "inbound",
            "outbound",
            "both"
          ],
          "default": "both"
        },
        "depth": {
          "type": "integer",
          "default": 3
        },
        "mode": {
          "type": "string",
          "enum": [
            "calls",
            "data_flow",
            "cross_service"
          ],
          "default": "calls",
          "description": "calls: follow CALLS edges. data_flow: follow CALLS+DATA_FLOWS with arg expressions. cross_service: follow HTTP_CALLS+ASYNC_CALLS+DATA_FLOWS through Routes, plus CROSS_* cross-repo edges (CROSS_HTTP_CALLS/ASYNC_CALLS/CHANNEL/GRPC_CALLS/GRAPHQL_CALLS/TRPC_CALLS) to hop into other services."
        },
        "parameter_name": {
          "type": "string",
          "description": "For data_flow mode: scope trace to a specific parameter name"
        },
        "edge_types": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "risk_labels": {
          "type": "boolean",
          "default": false,
          "description": "Add risk classification (CRITICAL/HIGH/MEDIUM/LOW) based on hop distance"
        },
        "include_tests": {
          "type": "boolean",
          "default": false,
          "description": "Include test files in results. When false (default), test files are filtered out. When true, test nodes are included with is_test=true marker."
        }
      },
      "required": [
        "function_name",
        "project"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "get_code_snippet",
    "title": "Get code snippet",
    "description": "Read source code for a function/class/symbol. IMPORTANT: First call search_graph to find the exact qualified_name, then pass it here. This is a read tool, not a search tool. Accepts full qualified_name (exact match) or short function name (returns suggestions if ambiguous).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "qualified_name": {
          "type": "string",
          "description": "Full qualified_name from search_graph, or short function name"
        },
        "project": {
          "type": "string"
        },
        "include_neighbors": {
          "type": "boolean",
          "default": false
        }
      },
      "required": [
        "qualified_name",
        "project"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "get_graph_schema",
    "title": "Get graph schema",
    "description": "Get the schema of the knowledge graph (node labels, edge types)",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string"
        }
      },
      "required": [
        "project"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "get_architecture",
    "title": "Get architecture",
    "description": "Get high-level architecture overview — packages, services, dependencies, and project structure at a glance. Includes 'clusters': Leiden community detection over the call/import graph, surfacing the de-facto modules (each with a label, member count, cohesion score, representative top_nodes, and the packages/edge_types that bind it) — use these to grasp the real architectural seams, which often cut across the folder layout. Optional path scopes analysis to nodes under that directory prefix (file_path).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string"
        },
        "path": {
          "type": "string",
          "description": "Optional directory prefix to scope architecture (e.g. apps/hoa)"
        },
        "aspects": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "all",
              "overview",
              "structure",
              "dependencies",
              "routes",
              "languages",
              "packages",
              "entry_points",
              "hotspots",
              "boundaries",
              "layers",
              "file_tree",
              "clusters"
            ]
          },
          "description": "Aspects to include. 'all' = everything; 'overview' = compact summary (all except file_tree); omit = all."
        }
      },
      "required": [
        "project"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "search_code",
    "title": "Search code",
    "description": "Graph-augmented code search. Finds text patterns via grep, then enriches results with the knowledge graph: deduplicates matches into containing functions, ranks by structural importance (definitions first, popular functions next, tests last). Modes: compact (default, signatures only — token efficient), full (with source), files (just file paths). Use path_filter regex to scope results. TRUNCATION: enriched results are capped at limit (default 10). Response carries 'total_grep_matches' (raw grep hit count) and 'total_results' (deduplicated function count) — compare to limit to detect truncation. There is no offset parameter; to see more, raise limit or narrow the query with file_pattern / path_filter.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string"
        },
        "project": {
          "type": "string"
        },
        "file_pattern": {
          "type": "string",
          "description": "Glob for grep --include (e.g. *.go)"
        },
        "path_filter": {
          "type": "string",
          "description": "Regex filter on result file paths (e.g. ^src/ or \\.(go|ts)$)"
        },
        "mode": {
          "type": "string",
          "enum": [
            "compact",
            "full",
            "files"
          ],
          "default": "compact",
          "description": "compact: signatures+metadata (default). full: with source. files: just file list."
        },
        "context": {
          "type": "integer",
          "description": "Lines of context around each match (like grep -C). Only used in compact mode."
        },
        "regex": {
          "type": "boolean",
          "default": false
        },
        "limit": {
          "type": "integer",
          "description": "Max enriched results per call. Default 10. Response includes 'total_grep_matches' and 'total_results' so callers can detect truncation. No offset parameter — raise limit or narrow with file_pattern / path_filter to see more.",
          "default": 10
        }
      },
      "required": [
        "pattern",
        "project"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "list_projects",
    "title": "List projects",
    "description": "List all indexed projects",
    "inputSchema": {
      "type": "object",
      "properties": {}
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "delete_project",
    "title": "Delete project",
    "description": "Delete a project from the index",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string"
        }
      },
      "required": [
        "project"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "index_status",
    "title": "Index status",
    "description": "Get the indexing status of a project",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string"
        }
      },
      "required": [
        "project"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "detect_changes",
    "title": "Detect changes",
    "description": "Detect code changes and their impact",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string"
        },
        "scope": {
          "type": "string"
        },
        "depth": {
          "type": "integer",
          "default": 2
        },
        "base_branch": {
          "type": "string",
          "default": "main"
        },
        "since": {
          "type": "string",
          "description": "Git ref or tag to compare from (e.g. HEAD~5, v0.5.0). Diffs <ref>...HEAD."
        }
      },
      "required": [
        "project"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "manage_adr",
    "title": "Manage ADR",
    "description": "Create or update Architecture Decision Records",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project": {
          "type": "string"
        },
        "mode": {
          "type": "string",
          "enum": [
            "get",
            "update",
            "sections"
          ]
        },
        "content": {
          "type": "string"
        },
        "sections": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "project"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  },
  {
    "name": "ingest_traces",
    "title": "Ingest traces",
    "description": "Ingest runtime traces to enhance the knowledge graph",
    "inputSchema": {
      "type": "object",
      "properties": {
        "traces": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "caller": {
                "type": "string"
              },
              "callee": {
                "type": "string"
              },
              "count": {
                "type": "integer"
              }
            },
            "additionalProperties": false
          }
        },
        "project": {
          "type": "string"
        }
      },
      "required": [
        "traces",
        "project"
      ]
    },
    "outputSchema": {
      "type": "object",
      "additionalProperties": true
    }
  }
] as const;
