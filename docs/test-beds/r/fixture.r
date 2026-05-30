# R test bed
source("helper.R")

Box <- function(value) {
  list(value = value)
}

Container <- setRefClass("Container",
  fields = list(items = "list"),
  methods = list(
    add = function(item) { items <<- c(items, list(item)) },
    size = function() { length(items) }
  )
)

process <- function(input) {
  c <- Container$new(items = list())
  c$add(input)
  Helper.log(c)
  c
}

FOO <- 42
