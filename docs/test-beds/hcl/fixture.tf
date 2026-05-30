# HCL/Terraform test bed
variable "region" {
  type    = string
  default = "us-east-1"
}

resource "aws_instance" "container" {
  ami           = "ami-12345"
  instance_type = "t3.micro"

  tags = {
    Name = "test-container"
  }
}

resource "aws_lb" "process" {
  name               = "process-lb"
  load_balancer_type = "application"
}

output "container_id" {
  value = aws_instance.container.id
}
