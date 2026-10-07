#!/usr/bin/env python3
"""Start the HTTP API: python run_server.py [--port 8000]. Docs at /docs."""

import argparse

import uvicorn

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    uvicorn.run("robot_sim.api:app", host=args.host, port=args.port)
