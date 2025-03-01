#!/bin/bash
gunicorn app:app -c gunicorn.conf.py
