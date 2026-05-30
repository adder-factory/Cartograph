-- Lua test bed
local Helper = require("helper")
local Utils = require "lib.utils"

local M = {}

function Box(value)
  return { value = value }
end

local function add(x, y)
  return x + y
end

function M.pack(items)
  local out = {}
  for i, v in ipairs(items) do
    out[i] = v * 2
  end
  return out
end

function M:size()
  return #self.items
end

function process(input)
  local c = Box(input)
  Helper.log(c)
  Utils.size(c)
  return c
end

local FOO = 42
local PI = 3.14

return M
