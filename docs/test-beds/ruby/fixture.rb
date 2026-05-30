# Ruby test bed
require_relative 'helper'

class Box
  attr_accessor :value
  def initialize(value); @value = value; end
end

class Container
  def initialize; @items = []; end
  def add(item); @items << item; end
  def size; @items.length; end
end

def process(input)
  c = Container.new
  c.add(input)
  Helper.log(c)
  c
end

FOO = 42
