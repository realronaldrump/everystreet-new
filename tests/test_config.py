import os
import unittest
from unittest.mock import patch

import config


class MapboxTokenTests(unittest.TestCase):
    def test_require_mapbox_token_missing(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                config.require_mapbox_token()

    def test_require_mapbox_token_requires_public_prefix(self):
        with patch.dict(os.environ, {"MAPBOX_TOKEN": "sk.invalidtokenvalue"}, clear=True):
            with self.assertRaises(RuntimeError):
                config.require_mapbox_token()

    def test_require_mapbox_token_min_length(self):
        with patch.dict(os.environ, {"MAPBOX_TOKEN": "pk.short"}, clear=True):
            with self.assertRaises(RuntimeError):
                config.require_mapbox_token()

    def test_require_mapbox_token_valid(self):
        token = "pk." + ("a" * 20)
        with patch.dict(os.environ, {"MAPBOX_TOKEN": token}, clear=True):
            self.assertEqual(config.require_mapbox_token(), token)


if __name__ == "__main__":
    unittest.main()
